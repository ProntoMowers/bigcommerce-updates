'use strict';

/**
 * Script: syncLongEtaPreorders.js
 *
 * Flujo:
 *  A) Busca partes únicas (MFRID + PARTNUMBER) en IDEAL (Firebird)
 *     para backorders Internet con antigüedad > DAYS_THRESHOLD.
 *  A.1) Resuelve productos por tienda con Parts Reverse Lookup API,
 *       actualiza BigCommerce + MongoDB a preorder.
 *  A.2) Upsert en prontoweb.long_eta_products con expectedreceiveddate.
 *  A.3) Si existe con user != 'system', también se actualiza preorder
 *       (cubierto por A.1 al procesar todas las partes activas).
 *  A.4) Partes system que ya no están activas se mueven a history
 *       y sus productos se revierten a availability=available.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { MongoClient } = require('mongodb');
const createLogger = require('../helpers/logger');
const {
  getMySqlConnection,
  getFirebirdConnection,
  firebirdQuery,
} = require('../providers/dbConnections');

const SCRIPT_NAME = 'syncLongEtaPreorders';
const logger = createLogger(SCRIPT_NAME);

const REVERSE_LOOKUP_URL =
  process.env.PARTS_REVERSE_API_URL ||
  process.env.PARTS_REVERSE_LOOKUP_API_URL ||
  'http://10.1.10.21:3001/v1/parts/reverse/resolve';
const PARTS_API_KEY = process.env.PARTS_API_KEY || '';

const DAYS_THRESHOLD = Number.parseInt(process.env.DAYS_THRESHOLD || '15', 10);
const RELEASE_OFFSET_DAYS = Number.parseInt(process.env.LONG_ETA_OFFSET_DAYS || '30', 10);
const DAYS_THRESHOLD2 = Number.parseInt(process.env.DAYS_THRESHOLD2 || '0', 10);
const RELEASE_OFFSET_DAYS2 = Number.parseInt(process.env.LONG_ETA_OFFSET_DAYS2 || '0', 10);
const REVERSE_BATCH_SIZE = Number.parseInt(process.env.REVERSE_BATCH_SIZE || '50', 10);
const REVERSE_TIMEOUT_MS = Number.parseInt(process.env.REVERSE_TIMEOUT_MS || '120000', 10);
const REVERSE_RETRIES = Number.parseInt(process.env.REVERSE_RETRIES || '2', 10);
const REVERSE_MIN_BATCH_SIZE = Number.parseInt(process.env.REVERSE_MIN_BATCH_SIZE || '10', 10);
const REVERSE_MAX_CONSECUTIVE_TIMEOUTS = Number.parseInt(
  process.env.REVERSE_MAX_CONSECUTIVE_TIMEOUTS || '3',
  10
);
const REVERSE_CONCURRENCY = Number.parseInt(process.env.REVERSE_CONCURRENCY || '5', 10);
const BC_BATCH_SIZE = Math.min(Number.parseInt(process.env.BC_BATCH_SIZE || '10', 10), 10);

const ONLY_MFRID = normalizeText(process.env.ONLY_MFRID || '');
const ONLY_PARTNUMBER = normalizeText(process.env.ONLY_PARTNUMBER || '');
const FORCE_SINGLE_PART = String(process.env.FORCE_SINGLE_PART || 'false').toLowerCase() === 'true';

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'Prontoweb';
const MONGO_PRODUCTS_COLLECTION = process.env.MONGO_PRODUCTS_COLLECTION || 'Products';

const stats = {
  partsFromIdeal: 0,
  partsExcludedNoListar: 0,
  reverseMatchedParts: 0,
  preorderProductsUpdatedBC: 0,
  preorderProductsUpdatedMongo: 0,
  availableProductsUpdatedBC: 0,
  availableProductsUpdatedMongo: 0,
  longEtaInserted: 0,
  longEtaUpdated: 0,
  longEtaArchived: 0,
  mongoPreorderWithoutLongEta: 0,
  mongoPreorderReportFile: null,
  errors: 0,
};

const tableColumnsCache = new Map();

function normalizeText(value) {
  return String(value || '').trim().toUpperCase();
}

function toPartKey(mfrid, partnumber) {
  return `${normalizeText(mfrid)}|||${normalizeText(partnumber)}`;
}

function chunkArray(items, size) {
  if (!Array.isArray(items) || size <= 0) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function toDateYMD(dateInput) {
  const d = new Date(dateInput);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function addDays(baseDate, days) {
  const d = new Date(baseDate);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Elige el offset de días para calcular preorder_release_date según la antigüedad de la parte.
 * Si DAYS_THRESHOLD2 y LONG_ETA_OFFSET_DAYS2 están configurados y ageDays >= DAYS_THRESHOLD2,
 * se usa el offset del segundo tier.
 */
function getReleaseOffsetForPart(ageDays) {
  if (DAYS_THRESHOLD2 > 0 && RELEASE_OFFSET_DAYS2 > 0 && Number.isFinite(ageDays) && ageDays >= DAYS_THRESHOLD2) {
    return RELEASE_OFFSET_DAYS2;
  }
  return RELEASE_OFFSET_DAYS;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(error) {
  if (!error) return false;
  if (error.code === 'ECONNABORTED') return true;
  const message = String(error.message || '').toLowerCase();
  return message.includes('timeout');
}

function sanitizeZeroDate(value) {
  if (value === null || value === undefined) return value;
  const str = String(value).trim();
  if (str.startsWith('0000-00-00')) return null;
  return value;
}

function ensureLogsDir() {
  const logsDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
  }
  return logsDir;
}

function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (/[,"\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function createBCClient(storeHash, accessToken) {
  return axios.create({
    baseURL: `https://api.bigcommerce.com/stores/${storeHash}/v3`,
    headers: {
      'X-Auth-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });
}

async function getTableColumns(tableName) {
  if (tableColumnsCache.has(tableName)) {
    return tableColumnsCache.get(tableName);
  }

  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    `SELECT COLUMN_NAME
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?`,
    [tableName]
  );

  const cols = new Set(rows.map((r) => r.COLUMN_NAME));
  tableColumnsCache.set(tableName, cols);
  return cols;
}

async function insertAdaptive(tableName, dataObj) {
  const pool = getMySqlConnection();
  const columns = await getTableColumns(tableName);

  const entries = Object.entries(dataObj).filter(([key, val]) => columns.has(key) && val !== undefined);
  if (!entries.length) {
    throw new Error(`No hay columnas compatibles para insertar en ${tableName}`);
  }

  const fields = entries.map(([key]) => `\`${key}\``).join(', ');
  const placeholders = entries.map(() => '?').join(', ');
  const values = entries.map(([, val]) => val);

  const sql = `INSERT INTO \`${tableName}\` (${fields}) VALUES (${placeholders})`;
  await pool.execute(sql, values);
}

async function getAgedBackorderParts(daysThreshold) {
  const db = await getFirebirdConnection();

  const sql = `
    SELECT
      pod.MFRID,
      pod.PARTNUMBER,
      MIN(po.ORDERDATE) AS FIRST_ORDERDATE
    FROM PURCHASEORDERDETAIL pod
    JOIN PURCHASEORDER po
      ON po.PURCHASEORDERID = pod.PURCHASEORDERID
    JOIN SALESORDER so
      ON so.SALESORDERID = pod.CALCSALESORDERID
    WHERE pod.CALCSALESORDERID IS NOT NULL
      AND TRIM(pod.CALCSALESORDERID) <> ''
      AND po.PURCHASEORDERSTATUS IN ('B', 'O')
      AND UPPER(TRIM(so.SALESREP)) = 'INTERNET'
    GROUP BY
      pod.MFRID,
      pod.PARTNUMBER
    ORDER BY
      FIRST_ORDERDATE ASC,
      pod.MFRID,
      pod.PARTNUMBER
  `;

  try {
    const rows = await firebirdQuery(db, sql);
    const dedup = new Map();
    const now = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;

    for (const row of rows) {
      const mfrid = row.MFRID ?? row.mfrid;
      const partnumber = row.PARTNUMBER ?? row.partnumber;
      const firstOrderDate = row.FIRST_ORDERDATE ?? row.first_orderdate;
      const firstOrderDateObj = firstOrderDate ? new Date(firstOrderDate) : null;
      if (!firstOrderDateObj || Number.isNaN(firstOrderDateObj.getTime())) continue;

      const ageDays = Math.floor((now.getTime() - firstOrderDateObj.getTime()) / msPerDay);
      if (!Number.isFinite(ageDays) || ageDays <= daysThreshold) continue;

      const key = toPartKey(mfrid, partnumber);
      if (!normalizeText(mfrid) || !normalizeText(partnumber)) continue;
      if (dedup.has(key)) continue;

      dedup.set(key, {
        mfrid: normalizeText(mfrid),
        partnumber: normalizeText(partnumber),
        firstOrderDate: toDateYMD(firstOrderDate),
        ageDays,
      });
    }

    return [...dedup.values()];
  } finally {
    db.detach();
  }
}

async function getSinglePartDiagnostics(mfrid, partnumber, daysThreshold) {
  const db = await getFirebirdConnection();
  try {
    const params = [normalizeText(mfrid), normalizeText(partnumber)];
    const byPart = `
      UPPER(TRIM(pod.MFRID)) = ?
      AND UPPER(TRIM(pod.PARTNUMBER)) = ?
    `;

    const qAll = `SELECT COUNT(*) AS C FROM PURCHASEORDERDETAIL pod WHERE ${byPart}`;
    const qWithPo = `
      SELECT COUNT(*) AS C
      FROM PURCHASEORDERDETAIL pod
      JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID
      WHERE ${byPart}
        AND po.PURCHASEORDERSTATUS IN ('B', 'O')
    `;
    const qWithSo = `
      SELECT COUNT(*) AS C
      FROM PURCHASEORDERDETAIL pod
      JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID
      JOIN SALESORDER so ON so.SALESORDERID = pod.CALCSALESORDERID
      WHERE ${byPart}
        AND pod.CALCSALESORDERID IS NOT NULL
        AND TRIM(pod.CALCSALESORDERID) <> ''
        AND po.PURCHASEORDERSTATUS IN ('B', 'O')
        AND UPPER(TRIM(so.SALESREP)) = 'INTERNET'
    `;
    const qAge = `
      SELECT MIN(po.ORDERDATE) AS FIRST_ORDERDATE
      FROM PURCHASEORDERDETAIL pod
      JOIN PURCHASEORDER po ON po.PURCHASEORDERID = pod.PURCHASEORDERID
      JOIN SALESORDER so ON so.SALESORDERID = pod.CALCSALESORDERID
      WHERE ${byPart}
        AND pod.CALCSALESORDERID IS NOT NULL
        AND TRIM(pod.CALCSALESORDERID) <> ''
        AND po.PURCHASEORDERSTATUS IN ('B', 'O')
        AND UPPER(TRIM(so.SALESREP)) = 'INTERNET'
    `;

    const [rAll] = await firebirdQuery(db, qAll, params);
    const [rPo] = await firebirdQuery(db, qWithPo, params);
    const [rSo] = await firebirdQuery(db, qWithSo, params);
    const [rAge] = await firebirdQuery(db, qAge, params);

    const firstOrderDate = rAge?.FIRST_ORDERDATE ?? rAge?.first_orderdate ?? null;
    let ageDays = null;
    if (firstOrderDate) {
      const msPerDay = 24 * 60 * 60 * 1000;
      ageDays = Math.floor((Date.now() - new Date(firstOrderDate).getTime()) / msPerDay);
    }

    return {
      countByPart: Number(rAll?.C ?? rAll?.c ?? 0),
      countStatusB: Number(rPo?.C ?? rPo?.c ?? 0),
      countWithSalesOrderInternet: Number(rSo?.C ?? rSo?.c ?? 0),
      firstOrderDate: firstOrderDate ? toDateYMD(firstOrderDate) : null,
      ageDays,
      daysThreshold,
    };
  } finally {
    db.detach();
  }
}

async function resolvePartsInReverseLookup(parts) {
  const resultMap = new Map();
  if (!parts.length) return resultMap;

  logger.info(`Reverse lookup: ${parts.length} partes (concurrencia=${REVERSE_CONCURRENCY})`);
  let consecutiveTimeoutFailures = 0;

  async function fetchReverseBatch(batch, depth = 0) {
    const payload = {
      parts: batch.map((p) => ({
        mfrid: p.mfrid,
        partnumber: p.partnumber,
      })),
    };

    for (let attempt = 1; attempt <= REVERSE_RETRIES + 1; attempt++) {
      try {
        const response = await axios.post(REVERSE_LOOKUP_URL, payload, {
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': PARTS_API_KEY,
          },
          timeout: REVERSE_TIMEOUT_MS,
        });

        const results = response.data?.results || [];

        if (ONLY_MFRID && ONLY_PARTNUMBER) {
          logger.info(`[DEBUG] Reverse API raw response:\n${JSON.stringify(response.data, null, 2)}`);
        }

        for (const item of results) {
          const input = item.input || {};
          const key = toPartKey(input.mfrid, input.partnumber);
          const matches = Array.isArray(item.matches) ? item.matches : [];
          resultMap.set(key, matches);
        }
        return { ok: true, timeoutFailure: false };
      } catch (error) {
        const canRetry = attempt <= REVERSE_RETRIES;
        const timeout = isTimeoutError(error);

        if (canRetry) {
          const waitMs = 1000 * attempt;
          logger.warn(
            `Reverse timeout/error lote(${batch.length}) intento ${attempt}/${REVERSE_RETRIES + 1}: ${error.message}. Reintento en ${waitMs}ms`
          );
          await sleep(waitMs);
          continue;
        }

        if (timeout && batch.length > REVERSE_MIN_BATCH_SIZE) {
          const mid = Math.ceil(batch.length / 2);
          const left = batch.slice(0, mid);
          const right = batch.slice(mid);
          logger.warn(
            `Timeout persistente en lote(${batch.length}). Dividiendo en ${left.length}+${right.length} (depth=${depth + 1})`
          );
          const leftResult = await fetchReverseBatch(left, depth + 1);
          const rightResult = await fetchReverseBatch(right, depth + 1);
          return {
            ok: Boolean(leftResult?.ok || rightResult?.ok),
            timeoutFailure: Boolean(leftResult?.timeoutFailure && rightResult?.timeoutFailure),
          };
        }

        stats.errors++;
        logger.error(`Error reverse lookup lote (${batch.length}): ${error.message}`);
        if (error.response?.data) {
          logger.error(`Reverse response: ${JSON.stringify(error.response.data)}`);
        }
        return { ok: false, timeoutFailure: timeout };
      }
    }

    return { ok: false, timeoutFailure: false };
  }

  for (let i = 0; i < parts.length; i += REVERSE_CONCURRENCY) {
    const group = parts.slice(i, i + REVERSE_CONCURRENCY);
    const results = await Promise.all(group.map((p) => fetchReverseBatch([p])));

    const hadTimeout = results.some((r) => r?.timeoutFailure);
    if (hadTimeout) {
      consecutiveTimeoutFailures++;
    } else {
      consecutiveTimeoutFailures = 0;
    }

    if (consecutiveTimeoutFailures >= REVERSE_MAX_CONSECUTIVE_TIMEOUTS) {
      throw new Error(
        `Reverse Lookup API no está respondiendo (timeouts consecutivos=${consecutiveTimeoutFailures}). Aborting para evitar ejecución excesiva.`
      );
    }

    const completed = Math.min(i + REVERSE_CONCURRENCY, parts.length);
    const pct = ((completed / parts.length) * 100).toFixed(1);
    logger.info(`Reverse lookup progreso: ${completed}/${parts.length} (${pct}%)`);
  }

  return resultMap;
}

function buildStoreProductsMap(parts, reverseMap) {
  const byStore = new Map();
  const dedupProduct = new Set();

  for (const part of parts) {
    const key = toPartKey(part.mfrid, part.partnumber);
    const matches = reverseMap.get(key) || [];

    if (matches.length > 0) stats.reverseMatchedParts++;

    for (const match of matches) {
      const storeId = Number(match.STOREID ?? match.storeId ?? match.storeid);
      const productId = Number(match.ID ?? match.id ?? match.productId ?? match.product_id);

      if (!Number.isFinite(storeId) || !Number.isFinite(productId)) continue;

      const dedupKey = `${storeId}::${productId}`;
      if (dedupProduct.has(dedupKey)) continue;
      dedupProduct.add(dedupKey);

      if (!byStore.has(storeId)) byStore.set(storeId, []);
      byStore.get(storeId).push({
        storeId,
        productId,
        mfrid: part.mfrid,
        partnumber: part.partnumber,
        releaseDateYMD: part.releaseDateYMD || null,
      });
    }
  }

  return byStore;
}

async function getStoreCredentialsMap(storeIds) {
  const pool = getMySqlConnection();
  const ids = [...new Set(storeIds)].filter((id) => Number.isFinite(id));
  if (!ids.length) return new Map();

  const placeholders = ids.map(() => '?').join(', ');
  const sql = `
    SELECT id, STOREHASH, ACCESSTOKEN, name
    FROM stores
    WHERE id IN (${placeholders})
  `;

  const [rows] = await pool.execute(sql, ids);
  const map = new Map();
  for (const row of rows) {
    map.set(Number(row.id), row);
  }

  return map;
}

async function updateBCPreorder(client, productId, releaseDateYMD) {
  // BigCommerce requires full ISO 8601 datetime for preorder_release_date
  const releaseDateISO = releaseDateYMD ? `${releaseDateYMD}T00:00:00+00:00` : null;
  // availability_description is intentionally NOT sent to preserve existing store text
  await client.put(`/catalog/products/${productId}`, {
    availability: 'preorder',
    preorder_release_date: releaseDateISO,
  });
}

async function updateBCAvailable(client, productId) {
  await client.put(`/catalog/products/${productId}`, {
    availability: 'available',
    preorder_release_date: null,
  });
}

/**
 * BC batch update: hasta BC_BATCH_SIZE (max 10) productos por llamada.
 * PUT /v3/catalog/products acepta un array con campo `id` + campos a actualizar.
 */
async function updateBCBatch(client, items, mode, releaseDateYMDFallback) {
  const payload = items.map((item) => {
    const dateYMD = item.releaseDateYMD || releaseDateYMDFallback;
    const dateISO = dateYMD ? `${dateYMD}T00:00:00+00:00` : null;
    if (mode === 'preorder') {
      return { id: item.productId, availability: 'preorder', preorder_release_date: dateISO };
    }
    return { id: item.productId, availability: 'available', preorder_release_date: null };
  });
  await client.put('/catalog/products', payload);
}

async function updateMongoPreorder(collection, storeId, productId, preorderMessage, releaseDateYMD) {
  const now = new Date();
  const filter = {
    $or: [
      { STOREID: storeId, ID: productId },
      { STOREID: String(storeId), ID: productId },
      { STOREID: storeId, ID: String(productId) },
      { STOREID: String(storeId), ID: String(productId) },
      { store_id: storeId, product_id: productId },
      { store_id: String(storeId), product_id: productId },
      { store_id: storeId, product_id: String(productId) },
      { store_id: String(storeId), product_id: String(productId) },
    ],
  };

  const update = {
    $set: {
      availability: 'preorder',
      availability_description: preorderMessage,
      preorder_release_date: releaseDateYMD,
      expectedreceiveddate: releaseDateYMD,
      updated_at: now,
    },
  };

  await collection.updateMany(filter, update);
}

async function updateMongoAvailable(collection, storeId, productId) {
  const now = new Date();
  const filter = {
    $or: [
      { STOREID: storeId, ID: productId },
      { STOREID: String(storeId), ID: productId },
      { STOREID: storeId, ID: String(productId) },
      { STOREID: String(storeId), ID: String(productId) },
      { store_id: storeId, product_id: productId },
      { store_id: String(storeId), product_id: productId },
      { store_id: storeId, product_id: String(productId) },
      { store_id: String(storeId), product_id: String(productId) },
    ],
  };

  const update = {
    $set: {
      availability: 'available',
      availability_description: '',
      updated_at: now,
    },
    $unset: {
      preorder_release_date: '',
      expectedreceiveddate: '',
    },
  };

  await collection.updateMany(filter, update);
}

async function applyAvailabilityUpdates({
  mode,
  storeProductsMap,
  mongoCollection,
  releaseDateYMD,
  preorderMessage,
}) {
  const storeIds = [...storeProductsMap.keys()];
  const storesMap = await getStoreCredentialsMap(storeIds);

  for (const storeId of storeIds) {
    const products = storeProductsMap.get(storeId) || [];
    if (!products.length) continue;

    const store = storesMap.get(storeId);
    if (!store) {
      stats.errors++;
      logger.warn(`Store ${storeId} no encontrada en tabla stores`);
      continue;
    }

    const client = createBCClient(store.STOREHASH, store.ACCESSTOKEN);
    logger.info(`Store ${storeId} (${store.name}) -> productos a actualizar: ${products.length} (lotes BC de ${BC_BATCH_SIZE})`);

    // --- BigCommerce: lotes de hasta BC_BATCH_SIZE (max 10) ---
    const bcChunks = chunkArray(products, BC_BATCH_SIZE);
    for (const chunk of bcChunks) {
      try {
        await updateBCBatch(client, chunk, mode, releaseDateYMD);
        if (mode === 'preorder') {
          stats.preorderProductsUpdatedBC += chunk.length;
        } else {
          stats.availableProductsUpdatedBC += chunk.length;
        }
      } catch (batchError) {
        // Fallback: intentar uno a uno si el lote falla
        logger.warn(
          `BC batch ${mode} error store=${storeId} lote(${chunk.length}): ${batchError.message}. Intentando individualmente...`
        );
        if (batchError.response?.data) {
          logger.error(`BC batch response body: ${JSON.stringify(batchError.response.data)}`);
        }
        for (const item of chunk) {
          const itemReleaseDateYMD = item.releaseDateYMD || releaseDateYMD;
          try {
            if (mode === 'preorder') {
              await updateBCPreorder(client, item.productId, itemReleaseDateYMD);
              stats.preorderProductsUpdatedBC++;
            } else {
              await updateBCAvailable(client, item.productId);
              stats.availableProductsUpdatedBC++;
            }
          } catch (err) {
            stats.errors++;
            logger.error(`BC ${mode} error store=${storeId} product=${item.productId}: ${err.message}`);
            if (err.response?.data) {
              logger.error(`BC response body: ${JSON.stringify(err.response.data)}`);
            }
          }
        }
      }
    }

    // --- MongoDB: paralelo por store ---
    await Promise.all(
      products.map(async (item) => {
        const itemReleaseDateYMD = item.releaseDateYMD || releaseDateYMD;
        try {
          if (mode === 'preorder') {
            await updateMongoPreorder(
              mongoCollection,
              storeId,
              item.productId,
              preorderMessage,
              itemReleaseDateYMD
            );
            stats.preorderProductsUpdatedMongo++;
          } else {
            await updateMongoAvailable(mongoCollection, storeId, item.productId);
            stats.availableProductsUpdatedMongo++;
          }
        } catch (error) {
          stats.errors++;
          logger.error(
            `Mongo ${mode} error store=${storeId} product=${item.productId}: ${error.message}`
          );
        }
      })
    );
  }
}

async function getLongEtaRecord(brand, sku) {
  const pool = getMySqlConnection();
  const sql = `
    SELECT *
    FROM long_eta_products
    WHERE UPPER(TRIM(brand)) = ?
      AND UPPER(TRIM(sku)) = ?
    LIMIT 1
  `;
  const [rows] = await pool.execute(sql, [normalizeText(brand), normalizeText(sku)]);
  return rows[0] || null;
}

async function upsertLongEtaSystem(part, releaseDateYMD, runDateYMD) {
  const pool = getMySqlConnection();
  const columns = await getTableColumns('long_eta_products');
  const existing = await getLongEtaRecord(part.mfrid, part.partnumber);

  if (existing) {
    const set = [];
    const setValues = [];

    if (columns.has('expectedreceiveddate')) {
      set.push('expectedreceiveddate = ?');
      setValues.push(releaseDateYMD);
    }

    if (columns.has('date')) {
      set.push('`date` = ?');
      setValues.push(runDateYMD);
    }

    if (columns.has('updated_at')) set.push('updated_at = NOW()');

    if (!set.length) return existing;

    let where = 'WHERE UPPER(TRIM(brand)) = ? AND UPPER(TRIM(sku)) = ?';
    let whereValues = [normalizeText(part.mfrid), normalizeText(part.partnumber)];

    if (Object.prototype.hasOwnProperty.call(existing, 'id') && columns.has('id')) {
      where = 'WHERE id = ?';
      whereValues = [existing.id];
    }

    const sql = `UPDATE long_eta_products SET ${set.join(', ')} ${where}`;
    await pool.execute(sql, [...setValues, ...whereValues]);
    stats.longEtaUpdated++;
    return existing;
  }

  const data = {
    brand: normalizeText(part.mfrid),
    sku: normalizeText(part.partnumber),
    expectedreceiveddate: releaseDateYMD,
    date: runDateYMD,
    user: 'system',
    created_at: new Date(),
    updated_at: new Date(),
  };

  await insertAdaptive('long_eta_products', data);
  stats.longEtaInserted++;
  return null;
}

async function getSystemLongEtaRows() {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    `SELECT * FROM long_eta_products WHERE LOWER(TRIM(\`user\`)) = 'system'`
  );
  return rows;
}

async function getAllLongEtaRows() {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute('SELECT brand, sku FROM long_eta_products');
  return rows;
}

async function getNoListarPartKeys() {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    `SELECT DISTINCT mfr, partnumber
     FROM no_listar_listprice
     WHERE mfr IS NOT NULL AND TRIM(mfr) <> ''
       AND partnumber IS NOT NULL AND TRIM(partnumber) <> ''`
  );

  const keys = new Set();
  for (const row of rows) {
    const key = toPartKey(row.mfr, row.partnumber);
    if (key !== '|||') keys.add(key);
  }
  return keys;
}

async function generateMongoPreorderWithoutLongEtaCsv(mongoCollection) {
  const longEtaRows = await getAllLongEtaRows();
  const longEtaSet = new Set(
    longEtaRows.map((row) => toPartKey(row.brand, row.sku))
  );

  const filter = {
    availability: 'preorder',
  };

  const projection = {
    STOREID: 1,
    store_id: 1,
    ID: 1,
    product_id: 1,
    BRAND: 1,
    brand: 1,
    MPN: 1,
    mpn: 1,
    SKU: 1,
    sku: 1,
    availability: 1,
    availability_description: 1,
    preorder_release_date: 1,
  };

  const logsDir = ensureLogsDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportPath = path.join(logsDir, `mongo_preorder_without_long_eta_${stamp}.csv`);

  const headers = [
    'store_id',
    'product_id',
    'brand',
    'mpn',
    'sku',
    'availability',
    'availability_description',
    'preorder_release_date',
    'reason',
  ];

  const lines = [headers.join(',')];
  let count = 0;

  const cursor = mongoCollection.find(filter, { projection });
  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    if (!doc) continue;

    const storeId = doc.STOREID ?? doc.store_id ?? '';
    const productId = doc.ID ?? doc.product_id ?? '';
    const brand = doc.BRAND ?? doc.brand ?? '';
    const mpn = doc.MPN ?? doc.mpn ?? '';
    const sku = doc.SKU ?? doc.sku ?? '';
    const partnumber = mpn || sku;

    const key = toPartKey(brand, partnumber);
    const hasBrand = normalizeText(brand).length > 0;
    const hasPart = normalizeText(partnumber).length > 0;

    const missingLongEta = !hasBrand || !hasPart || !longEtaSet.has(key);
    if (!missingLongEta) continue;

    const reason = !hasBrand || !hasPart ? 'missing_brand_or_partnumber_in_mongo' : 'not_found_in_long_eta_products';

    const row = [
      storeId,
      productId,
      brand,
      mpn,
      sku,
      doc.availability || '',
      doc.availability_description || '',
      doc.preorder_release_date || '',
      reason,
    ].map(csvEscape);

    lines.push(row.join(','));
    count++;
  }

  fs.writeFileSync(reportPath, lines.join('\n'), 'utf8');
  stats.mongoPreorderWithoutLongEta = count;
  stats.mongoPreorderReportFile = reportPath;

  logger.info(`Reporte CSV generado: ${reportPath}`);
  logger.info(`Mongo preorder fuera de long_eta_products: ${count}`);
}

async function archiveSystemRowsMissingInActiveParts(activePartsSet) {
  const pool = getMySqlConnection();
  const historyColumns = await getTableColumns('long_eta_products_his');
  const rows = await getSystemLongEtaRows();
  const archivedParts = [];

  for (const row of rows) {
    const key = toPartKey(row.brand, row.sku);
    if (activePartsSet.has(key)) continue;

    const archiveData = { ...row };
    delete archiveData.id;

    // Normalizar fechas inválidas heredadas de MySQL legacy
    for (const key of Object.keys(archiveData)) {
      if (key.toLowerCase().includes('date') || key.toLowerCase().includes('at')) {
        archiveData[key] = sanitizeZeroDate(archiveData[key]);
      }
    }

    if (historyColumns.has('moved_at')) archiveData.moved_at = new Date();

    try {
      await insertAdaptive('long_eta_products_his', archiveData);

      if (Object.prototype.hasOwnProperty.call(row, 'id')) {
        await pool.execute('DELETE FROM long_eta_products WHERE id = ?', [row.id]);
      } else {
        await pool.execute(
          `DELETE FROM long_eta_products
           WHERE UPPER(TRIM(brand)) = ?
             AND UPPER(TRIM(sku)) = ?
             AND LOWER(TRIM(\`user\`)) = 'system'`,
          [normalizeText(row.brand), normalizeText(row.sku)]
        );
      }

      stats.longEtaArchived++;
      archivedParts.push({
        mfrid: normalizeText(row.brand),
        partnumber: normalizeText(row.sku),
      });
    } catch (error) {
      stats.errors++;
      logger.error(`Error archivando long_eta (${row.brand}/${row.sku}): ${error.message}`);
    }
  }

  return archivedParts;
}

async function main() {
  const startedAt = Date.now();
  logger.info('===== INICIO syncLongEtaPreorders =====');
  logger.info(`DAYS_THRESHOLD=${DAYS_THRESHOLD}`);
  logger.info(`LONG_ETA_OFFSET_DAYS=${RELEASE_OFFSET_DAYS}`);

  if (!PARTS_API_KEY) {
    throw new Error('PARTS_API_KEY no está configurado');
  }

  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const mongoDb = mongoClient.db(MONGO_DB);
  const mongoCollection = mongoDb.collection(MONGO_PRODUCTS_COLLECTION);

  const runDateYMD = toDateYMD(new Date());
  // releaseDateYMD se calcula por parte según ageDays (ver getReleaseOffsetForPart)

  try {
    // A: IDEAL -> lista única de partes por antigüedad
    const activePartsRaw = await getAgedBackorderParts(DAYS_THRESHOLD);
    const noListarPartKeys = await getNoListarPartKeys();

    let activeParts =
      ONLY_MFRID && ONLY_PARTNUMBER
        ? activePartsRaw.filter(
            (p) => normalizeText(p.mfrid) === ONLY_MFRID && normalizeText(p.partnumber) === ONLY_PARTNUMBER
          )
        : activePartsRaw;

    const beforeNoListarFilter = activeParts.length;
    activeParts = activeParts.filter((p) => !noListarPartKeys.has(toPartKey(p.mfrid, p.partnumber)));
    stats.partsExcludedNoListar = beforeNoListarFilter - activeParts.length;

    stats.partsFromIdeal = activeParts.length;
    logger.info(`Partes activas desde IDEAL: ${activeParts.length}`);
    logger.info(`Partes excluidas por no_listar_listprice: ${stats.partsExcludedNoListar}`);
    if (ONLY_MFRID && ONLY_PARTNUMBER) {
      logger.info(`Filtro por parte habilitado: ${ONLY_MFRID}/${ONLY_PARTNUMBER}`);

      if (noListarPartKeys.has(toPartKey(ONLY_MFRID, ONLY_PARTNUMBER))) {
        logger.warn(
          `La parte ${ONLY_MFRID}/${ONLY_PARTNUMBER} está en no_listar_listprice y se excluye de la corrida Long ETA.`
        );
      }

      if (!activeParts.length) {
        const diag = await getSinglePartDiagnostics(ONLY_MFRID, ONLY_PARTNUMBER, DAYS_THRESHOLD);
        logger.warn(
          `Parte no elegible con filtros actuales -> byPart=${diag.countByPart}, statusB=${diag.countStatusB}, withSO+Internet=${diag.countWithSalesOrderInternet}, firstOrderDate=${diag.firstOrderDate || 'null'}, ageDays=${diag.ageDays ?? 'null'}, threshold=${diag.daysThreshold}`
        );

        if (FORCE_SINGLE_PART) {
          activeParts = [
            {
              mfrid: ONLY_MFRID,
              partnumber: ONLY_PARTNUMBER,
              firstOrderDate: diag.firstOrderDate,
              ageDays: diag.ageDays,
            },
          ];
          stats.partsFromIdeal = activeParts.length;
          logger.warn('FORCE_SINGLE_PART=true: se procesará la parte aunque no cumpla filtros de IDEAL.');
        }
      }
    }

    const activePartKeys = new Set(activeParts.map((p) => toPartKey(p.mfrid, p.partnumber)));
    const protectedPartKeys = new Set([...activePartKeys, ...noListarPartKeys]);

    // A.2 + A.3: mantener long_eta_products (system) y expected date
    for (const part of activeParts) {
      const offsetDays = getReleaseOffsetForPart(part.ageDays);
      part.releaseDateYMD = toDateYMD(addDays(new Date(), offsetDays));
      if (offsetDays !== RELEASE_OFFSET_DAYS) {
        logger.info(`Tier2 offset para ${part.mfrid}/${part.partnumber}: ageDays=${part.ageDays} >= ${DAYS_THRESHOLD2} -> offset=${offsetDays}d -> ${part.releaseDateYMD}`);
      }
      await upsertLongEtaSystem(part, part.releaseDateYMD, runDateYMD);
    }

    // A.1: actualizar preorder en BC + Mongo para partes activas
    const reverseMapActive = await resolvePartsInReverseLookup(activeParts);
    const storeProductsPreorder = buildStoreProductsMap(activeParts, reverseMapActive);

    await applyAvailabilityUpdates({
      mode: 'preorder',
      storeProductsMap: storeProductsPreorder,
      mongoCollection,
      releaseDateYMD: null,   // cada item lleva su propio releaseDateYMD
      preorderMessage: null,  // no se envía availability_description
    });

    // A.4: detectar system obsoletos, mover a history y volver products a available
    if (ONLY_MFRID && ONLY_PARTNUMBER) {
      logger.info('Modo single-part: se omite archivado masivo (A.4).');
    } else {
      const archivedParts = await archiveSystemRowsMissingInActiveParts(protectedPartKeys);
      logger.info(`Partes archivadas (system no activas): ${archivedParts.length}`);

      if (archivedParts.length) {
        const reverseMapArchived = await resolvePartsInReverseLookup(archivedParts);
        const storeProductsAvailable = buildStoreProductsMap(archivedParts, reverseMapArchived);

        await applyAvailabilityUpdates({
          mode: 'available',
          storeProductsMap: storeProductsAvailable,
          mongoCollection,
          releaseDateYMD: null,
          preorderMessage: null,
        });
      }
    }

    // Reporte adicional solicitado:
    // productos Mongo en preorder que no existen en long_eta_products
    await generateMongoPreorderWithoutLongEtaCsv(mongoCollection);

    const elapsedMs = Date.now() - startedAt;
    const elapsed = (elapsedMs / 1000).toFixed(1);
    const elapsedMin = (elapsedMs / 60000).toFixed(2);
    logger.info('===== RESUMEN =====');
    logger.info(`partsFromIdeal=${stats.partsFromIdeal}`);
    logger.info(`partsExcludedNoListar=${stats.partsExcludedNoListar}`);
    logger.info(`reverseMatchedParts=${stats.reverseMatchedParts}`);
    logger.info(`preorderProductsUpdatedBC=${stats.preorderProductsUpdatedBC}`);
    logger.info(`preorderProductsUpdatedMongo=${stats.preorderProductsUpdatedMongo}`);
    logger.info(`availableProductsUpdatedBC=${stats.availableProductsUpdatedBC}`);
    logger.info(`availableProductsUpdatedMongo=${stats.availableProductsUpdatedMongo}`);
    logger.info(`longEtaInserted=${stats.longEtaInserted}`);
    logger.info(`longEtaUpdated=${stats.longEtaUpdated}`);
    logger.info(`longEtaArchived=${stats.longEtaArchived}`);
    logger.info(`mongoPreorderWithoutLongEta=${stats.mongoPreorderWithoutLongEta}`);
    logger.info(`mongoPreorderReportFile=${stats.mongoPreorderReportFile || ''}`);
    logger.info(`errors=${stats.errors}`);
    logger.info(`Tiempo total: ${elapsed}s (${elapsedMin} min)`);
  } finally {
    await mongoClient.close();
    logger.info('Conexión Mongo cerrada');
  }
}

main().catch((error) => {
  logger.error(`Fallo fatal: ${error.message}`);
  process.exit(1);
});
