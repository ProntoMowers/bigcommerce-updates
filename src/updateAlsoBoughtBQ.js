/**
 * updateAlsoBoughtBQ.js
 *
 * Calcula "usually bought together" (co-compras en la MISMA ORDEN) desde BigQuery
 * y actualiza en BigCommerce hasta TOP 4 custom fields "__alsobought" por producto,
 * y genera un CSV por tienda con los productos actualizados y sus pares (con conteos).
 *
 * REGLAS:
 * - Ventana: últimos LOOKBACK_DAYS (default 730 días: 2 años).
 * - Sin filtros por status.
 * - Sólo órdenes con >= 2 productos distintos.
 * - Sólo pares con frecuencia >= MIN_FREQ (default 10).
 * - Se crean entre 1 y 4 "__alsobought" por producto (si hay pares que cumplan).
 *
 * Uso:
 *   node src/updateAlsoBoughtBQ.js <STORE_CODE|all> [PRODUCT_ID]
 *
 * Requisitos:
 * - MySQL (.env): MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE
 * - BigQuery en: config/bigquery.js (const bigquery = require('../config/bigquery'))
 * - Tabla MySQL `stores`: id, STOREHASH, ACCESSTOKEN, dataset_bigcommerce
 */

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const axios = require('axios');
require('dotenv').config();

const bigquery = require('../config/bigquery');

// ---------------------- Logger ----------------------
const SCRIPT_NAME = 'updateAlsoBoughtBQ';
const LOGS_DIR = path.join(process.cwd(), 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
const LOG_FILE = path.join(
  LOGS_DIR,
  `${SCRIPT_NAME}-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}.log`
);
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}
function dbg(...args) {
  if (String(process.env.DEBUG_BQ || '').toLowerCase() === '1') {
    log('DEBUG:', ...args);
  }
}

// ---------------------- Env ----------------------
const {
  MYSQL_HOST,
  MYSQL_USER,
  MYSQL_PASSWORD,
  MYSQL_DATABASE,
} = process.env;
if (!MYSQL_HOST || !MYSQL_USER || !MYSQL_PASSWORD || !MYSQL_DATABASE) {
  log('❌ Faltan vars MySQL en .env (MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, MYSQL_DATABASE)');
  process.exit(1);
}
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS || 730); // 2 años
const MAX_PRODUCTS_TO_UPDATE = Number(process.env.MAX_PRODUCTS_TO_UPDATE || 0); // 0 = sin límite
const DEFAULT_BQ_PROJECT = process.env.BIGQUERY_PROJECT_ID || 'bigcommerce-analitics';
const BQ_LOCATION = process.env.BQ_LOCATION || 'us-west1';
const MIN_FREQ = Math.max(1, Number(process.env.MIN_FREQ || 10)); // mínimo 10
const TOP_K = 4;

// ---------------------- MySQL helpers ----------------------
async function getMySqlConnection() {
  return mysql.createConnection({
    host: MYSQL_HOST,
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    multipleStatements: false,
    namedPlaceholders: true,
  });
}
async function getAllStoreIds(conn) {
  log('Obteniendo todos los store IDs desde la base de datos...');
  const [rows] = await conn.execute('SELECT id FROM stores');
  if (!rows || rows.length === 0) {
    log('⚠️ No se encontraron stores en la base de datos.');
    return [];
  }
  const ids = rows.map((r) => r.id);
  log(`Se encontraron ${ids.length} stores para procesar.`);
  return ids;
}
async function getStoreInfo(conn, storeId) {
  const sql = 'SELECT STOREHASH, ACCESSTOKEN, dataset_bigcommerce FROM stores WHERE id = ?';
  const [rows] = await conn.execute(sql, [storeId]);
  if (!rows || rows.length === 0) throw new Error(`Store con ID ${storeId} no encontrada`);
  const r = rows[0];
  if (!r.dataset_bigcommerce) throw new Error(`Store ${storeId} sin dataset_bigcommerce definido`);
  return { storeHash: r.STOREHASH, accessToken: r.ACCESSTOKEN, dataset: r.dataset_bigcommerce };
}

// ---------------------- BigQuery dataset resolver ----------------------
function resolveBQRefs(datasetFromDb) {
  const trimmed = String(datasetFromDb || '').trim();
  if (!trimmed) throw new Error('dataset_bigcommerce vacío en stores');

  let projectId = DEFAULT_BQ_PROJECT;
  let datasetId = trimmed;
  if (trimmed.includes('.')) {
    const [proj, ds] = trimmed.split('.');
    if (proj && ds) { projectId = proj; datasetId = ds; }
  }
  const fq = (table) => `\`${projectId}.${datasetId}.${table}\``;
  return { projectId, datasetId, fq };
}

// ---------------------- BigCommerce client ----------------------
function bcClient({ storeHash, accessToken }) {
  const baseURL = `https://api.bigcommerce.com/stores/${storeHash}`;
  const headers = {
    'X-Auth-Token': accessToken,
    'X-Auth-Client': 'Pronto-Mowers-Script',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
  const instance = axios.create({ baseURL, headers, timeout: 60000 });

  instance.interceptors.response.use(
    (r) => r,
    async (error) => {
      const cfg = error.config || {};
      cfg.__retryCount = cfg.__retryCount || 0;
      if (cfg.__retryCount < 3 && (!error.response || error.response.status >= 500)) {
        cfg.__retryCount += 1;
        const delay = 500 * cfg.__retryCount;
        await new Promise((res) => setTimeout(res, delay));
        return instance(cfg);
      }
      throw error;
    }
  );
  return instance;
}
async function listProductCustomFields(client, productId) {
  const resp = await client.get(`/v3/catalog/products/${productId}/custom-fields`, { params: { limit: 250 } });
  return resp.data?.data || [];
}
async function deleteCustomField(client, productId, customFieldId) {
  await client.delete(`/v3/catalog/products/${productId}/custom-fields/${customFieldId}`);
}
async function createCustomField(client, productId, name, value) {
  await client.post(`/v3/catalog/products/${productId}/custom-fields`, { name, value: String(value) });
}
async function upsertAlsoBoughtFields(client, productId, topIds /* number[] */) {
  const existing = await listProductCustomFields(client, productId);
  const toDelete = existing.filter((cf) => cf.name === '__alsobought');
  for (const cf of toDelete) await deleteCustomField(client, productId, cf.id);
  for (const otherId of topIds) await createCustomField(client, productId, '__alsobought', otherId);
  return { removed: toDelete.length, created: topIds.length };
}

// ---------------------- BigQuery: cálculo co-compras ----------------------
/**
 * Devuelve Map<number, Array<{id:number, cnt:number}>>: product_id => [{id, cnt}] (máx TOP_K por producto)
 * Reglas: ventana LOOKBACK_DAYS, sin filtro de status, órdenes con >=2 productos, pares >= MIN_FREQ
 * Si onlyProductId existe, calcula solo ese producto.
 */
async function getTopCoPurchasesFromBQ(dataset, { lookbackDays, onlyProductId = null, topK = TOP_K }) {
  const { projectId, datasetId, fq } = resolveBQRefs(dataset);
  const orderTable = fq('bc_order');
  const orderLineItemsTable = fq('bc_order_line_items');

  const query = `
    DECLARE lookback_days INT64 DEFAULT @lookback_days;
    DECLARE since_ts TIMESTAMP DEFAULT TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL lookback_days DAY);
    DECLARE min_freq INT64 DEFAULT @min_freq;

    WITH
    items AS (
      SELECT op.order_id, CAST(op.product_id AS INT64) AS product_id
      FROM ${orderLineItemsTable} op
      JOIN ${orderTable} o ON o.order_id = op.order_id
      WHERE CAST(o.order_created_date_time AS TIMESTAMP) >= since_ts
        AND op.product_id IS NOT NULL
    ),
    orders_multi AS (
      SELECT order_id FROM items GROUP BY order_id HAVING COUNT(DISTINCT product_id) >= 2
    ),
    items_multi AS (
      SELECT i.* FROM items i JOIN orders_multi m USING (order_id)
    ),
    pairs AS (
      SELECT
        a.product_id AS product_a,
        b.product_id AS product_b,
        COUNT(*) AS cnt
      FROM items_multi a
      JOIN items_multi b
        ON a.order_id = b.order_id AND a.product_id <> b.product_id
      ${onlyProductId ? 'WHERE a.product_id = @only_product_id' : ''}
      GROUP BY product_a, product_b
      HAVING COUNT(*) >= min_freq
    ),
    ranked AS (
      SELECT
        product_a,
        product_b,
        cnt,
        ROW_NUMBER() OVER (PARTITION BY product_a ORDER BY cnt DESC, product_b) AS rn
      FROM pairs
    )
    SELECT product_a, product_b, cnt
    FROM ranked
    WHERE rn <= @top_k
    ORDER BY product_a, rn;
  `;
  const params = {
    lookback_days: lookbackDays,
    top_k: Math.min(Math.max(topK, 1), 4),
    min_freq: MIN_FREQ,
    ...(onlyProductId ? { only_product_id: Number(onlyProductId) } : {}),
  };

  log(`🔎 BigQuery: project=${projectId} dataset=${datasetId} location=${BQ_LOCATION} lookback_days=${params.lookback_days} top_k=${params.top_k} min_freq=${params.min_freq}${onlyProductId ? ` only_product_id=${onlyProductId}` : ''}`);

  const [rows] = await bigquery.query({ query, params, location: BQ_LOCATION });

  // Transformar a Map<number, Array<{id, cnt}>>
  const map = new Map();
  for (const r of rows) {
    const a = Number(r.product_a);
    const b = Number(r.product_b);
    const cnt = Number(r.cnt);
    if (!map.has(a)) map.set(a, []);
    const arr = map.get(a);
    if (arr.length < params.top_k) arr.push({ id: b, cnt });
  }
  log(`✅ BigQuery co-compras: productos con vecinos=${map.size}, filas=${rows.length}`);
  return map;
}

// ---------------------- CSV helpers ----------------------
function timestampForFile() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
}
function buildCsvRow(productId, pairs /* [{id,cnt}] */) {
  // Hasta 4 columnas de par + conteo
  const cols = [
    `product_id,also_bought_1,times_together_1,also_bought_2,times_together_2,also_bought_3,times_together_3,also_bought_4,times_together_4`
  ];
  // No añadimos aquí; esto es el header. El cuerpo lo generamos aparte.
  return cols[0]; // placeholder (no usado)
}
function writeCsv(storeId, dataRows /* array of objects */) {
  // dataRows: { product_id, pairs: [{id,cnt}, ...] }
  const safeStore = `Store${storeId}`;
  const fileName = `alsobought_${safeStore}_${timestampForFile()}.csv`;
  const filePath = path.join(LOGS_DIR, fileName);

  const header = 'product_id,also_bought_1,times_together_1,also_bought_2,times_together_2,also_bought_3,times_together_3,also_bought_4,times_together_4';
  const lines = [header];

  for (const row of dataRows) {
    const pid = row.product_id;
    const pairs = row.pairs || [];
    const p1 = pairs[0]?.id ?? '';
    const c1 = pairs[0]?.cnt ?? '';
    const p2 = pairs[1]?.id ?? '';
    const c2 = pairs[1]?.cnt ?? '';
    const p3 = pairs[2]?.id ?? '';
    const c3 = pairs[2]?.cnt ?? '';
    const p4 = pairs[3]?.id ?? '';
    const c4 = pairs[3]?.cnt ?? '';

    lines.push([pid, p1, c1, p2, c2, p3, c3, p4, c4].join(','));
  }

  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
  log(`🧾 CSV generado: ${filePath}`);
  return filePath;
}

// ---------------------- Procesamiento por tienda ----------------------
async function processStore({ conn, storeId, singleProductId }) {
  log(`\n🏬 Iniciando procesamiento para store ${storeId}${singleProductId ? ` (producto ${singleProductId})` : ''}`);

  const { storeHash, accessToken, dataset } = await getStoreInfo(conn, storeId);
  const client = bcClient({ storeHash, accessToken });

  // 1) Obtener topK co-compras desde BigQuery (con conteos)
  const coMap = await getTopCoPurchasesFromBQ(dataset, {
    lookbackDays: LOOKBACK_DAYS,
    onlyProductId: singleProductId || null,
    topK: TOP_K,
  });

  if (coMap.size === 0) {
    log(`⚠️ No hay co-compras en la ventana analizada para store ${storeId}.`);
    // Igual generamos CSV vacío con header para trazabilidad del job
    writeCsv(storeId, []);
    return { processed: 0, updated: 0, skipped: 0 };
  }

  // 2) Determinar productos a actualizar (keys del mapa)
  let productIds = [...coMap.keys()];
  if (MAX_PRODUCTS_TO_UPDATE > 0 && productIds.length > MAX_PRODUCTS_TO_UPDATE) {
    productIds = productIds.slice(0, MAX_PRODUCTS_TO_UPDATE);
    log(`ℹ️ Se limitará la escritura a ${productIds.length} productos (MAX_PRODUCTS_TO_UPDATE=${MAX_PRODUCTS_TO_UPDATE}).`);
  }
  log(`🛠️ Productos a actualizar: ${productIds.length}`);

  // Para CSV: acumulamos rows
  const csvRows = [];

  // 3) Escribir custom fields en BigCommerce
  let updated = 0;
  let skipped = 0;
  for (let i = 0; i < productIds.length; i++) {
    const pid = productIds[i];
    const pairs = coMap.get(pid) || []; // [{id,cnt}]
    const topIds = pairs.map((p) => p.id);

    // CSV: guardar fila (aunque no escriba si por alguna razón no hay pares)
    csvRows.push({ product_id: pid, pairs });

    if (topIds.length === 0) {
      skipped++;
      continue;
    }

    try {
      const res = await upsertAlsoBoughtFields(client, pid, topIds);
      updated++;
      if ((i + 1) % 50 === 0 || singleProductId) {
        log(`   ✓ ${i + 1}/${productIds.length} Producto ${pid} → __alsobought = [${topIds.join(', ')}] (del: ${res.removed}, add: ${res.created})`);
      }
    } catch (e) {
      skipped++;
      log(`   ❌ Error actualizando producto ${pid}: ${e?.response?.status} ${e?.response?.statusText || e.message}`);
    }
  }

  // 4) Generar CSV
  writeCsv(storeId, csvRows);

  log(`✅ Resumen store ${storeId}: procesados=${productIds.length}, actualizados=${updated}, sin cambios/errores=${skipped}`);
  return { processed: productIds.length, updated, skipped };
}

// ---------------------- CLI ----------------------
(async function main() {
  const args = process.argv.slice(2);
  const storeCode = args[0];
  const productIdOpt = args[1] ? Number(args[1]) : null;

  log(`🚀 ${SCRIPT_NAME} iniciado`);
  log(`Parámetros: STORE_CODE=${storeCode || '(none)'} PRODUCT_ID=${productIdOpt || '(none)'} LOOKBACK_DAYS=${LOOKBACK_DAYS} MIN_FREQ=${MIN_FREQ} MAX_PRODUCTS_TO_UPDATE=${MAX_PRODUCTS_TO_UPDATE}`);

  if (!storeCode) {
    log('❗ Uso: node src/updateAlsoBoughtBQ.js <STORE_CODE|all> [PRODUCT_ID]');
    log('Sugerencia: usa "all" para procesar todas las tiendas.');
    process.exit(1);
  }

  const conn = await getMySqlConnection();
  try {
    let storeIds = [];
    if (storeCode === 'all') {
      storeIds = await getAllStoreIds(conn);
    } else {
      storeIds = [Number(storeCode)];
    }

    const totals = { stores: 0, processed: 0, updated: 0, skipped: 0 };
    for (const sid of storeIds) {
      totals.stores += 1;
      try {
        const res = await processStore({ conn, storeId: sid, singleProductId: productIdOpt || null });
        totals.processed += res.processed;
        totals.updated += res.updated;
        totals.skipped += res.skipped;
      } catch (e) {
        log(`💥 Error procesando store ${sid}: ${e.message}`);
      }
    }

    log('\n📊 TOTALES');
    log(`Tiendas: ${totals.stores}`);
    log(`Productos procesados: ${totals.processed}`);
    log(`Productos actualizados: ${totals.updated}`);
    log(`Productos sin cambios/errores: ${totals.skipped}`);
    log('🎉 Finalizado');
  } catch (err) {
    log(`💥 Error general: ${err.message}`);
    process.exitCode = 1;
  } finally {
    try { await conn.end(); } catch (_) {}
  }
})();
