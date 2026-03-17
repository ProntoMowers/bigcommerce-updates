'use strict';

/**
 * Script: fixMpnPkSuffix.js
 *
 * Busca productos en MongoDB cuyo MPN contenga "-PK" y recorta
 * el MPN a partir de ese sufijo (inclusive).
 * Ej: "1687806-PK2" → "1687806"
 *
 * Actualiza tanto MongoDB como BigCommerce.
 *
 * USO:
 *   node src/fixMpnPkSuffix.js
 *   node src/fixMpnPkSuffix.js --dry-run
 *
 * ENV opcionales:
 *   DRY_RUN=true         → solo reporta cambios, no escribe nada
 *   ONLY_STORE_ID=20     → procesa solo esa tienda
 *   ONLY_PRODUCT_ID=123  → procesa solo ese producto
 *   BC_BATCH_SIZE=10     → productos por lote en BC (máx 10)
 */

require('dotenv').config();
const axios = require('axios');
const { MongoClient } = require('mongodb');
const { getMySqlConnection } = require('../providers/dbConnections');
const createLogger = require('../helpers/logger');

const SCRIPT_NAME = 'fixMpnPkSuffix';
const logger = createLogger(SCRIPT_NAME);

// ─── Configuración ───────────────────────────────────────────────────────────
const DRY_RUN =
  String(process.env.DRY_RUN || 'false').toLowerCase() === 'true' ||
  process.argv.includes('--dry-run');

const ONLY_STORE_ID = process.env.ONLY_STORE_ID
  ? parseInt(process.env.ONLY_STORE_ID, 10)
  : null;
const ONLY_PRODUCT_ID = process.env.ONLY_PRODUCT_ID
  ? parseInt(process.env.ONLY_PRODUCT_ID, 10)
  : null;

const BC_BATCH_SIZE = Math.min(
  parseInt(process.env.BC_BATCH_SIZE || '10', 10),
  10
);

const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const MONGO_DB = process.env.MONGO_DB || 'Prontoweb';
const MONGO_COLLECTION = process.env.MONGO_PRODUCTS_COLLECTION || 'Products';

// ─── Estadísticas ────────────────────────────────────────────────────────────
const stats = {
  productsFound: 0,
  mongoUpdated: 0,
  bcUpdated: 0,
  skipped: 0,
  errors: 0,
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
function stripPkSuffix(mpn) {
  // Recorta desde "-PK" en adelante (case-insensitive)
  return mpn.replace(/-PK.*/i, '');
}

function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── BigCommerce ─────────────────────────────────────────────────────────────
function createBCClient(storeHash, accessToken) {
  const instance = axios.create({
    baseURL: `https://api.bigcommerce.com/stores/${storeHash}/v3`,
    headers: {
      'X-Auth-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  // Retry automático en 429/5xx
  instance.interceptors.response.use(
    (r) => r,
    async (error) => {
      const cfg = error.config || {};
      const status = error.response?.status;
      const shouldRetry =
        [429, 500, 502, 503, 504].includes(status) &&
        (cfg.__retryCount || 0) < 4;
      if (shouldRetry) {
        cfg.__retryCount = (cfg.__retryCount || 0) + 1;
        const waitMs = status === 429 ? 10000 : Math.min(1000 * 2 ** cfg.__retryCount, 12000);
        logger.warn(
          `BC HTTP ${status} → reintento #${cfg.__retryCount} en ${waitMs}ms [${cfg.url}]`
        );
        await sleep(waitMs);
        return instance(cfg);
      }
      throw error;
    }
  );

  return instance;
}

/**
 * Actualiza el MPN de un producto en BigCommerce.
 * Usa batch PUT /catalog/products cuando hay varios en el mismo lote.
 */
async function updateMpnInBC(client, productId, newMpn, storeId) {
  if (DRY_RUN) {
    logger.info(`[DRY-RUN] BC product ${productId} (store ${storeId}): mpn → "${newMpn}"`);
    return true;
  }

  try {
    await client.put(`/catalog/products/${productId}`, { mpn: newMpn });
    return true;
  } catch (error) {
    const status = error.response?.status;
    const detail = error.response?.data
      ? JSON.stringify(error.response.data)
      : error.message;
    logger.error(
      `Error BC PUT product ${productId} (store ${storeId}) HTTP ${status}: ${detail}`
    );
    stats.errors++;
    return false;
  }
}

// ─── MySQL ────────────────────────────────────────────────────────────────────
async function getStores() {
  const pool = getMySqlConnection();
  let sql = 'SELECT id, STOREHASH, ACCESSTOKEN, name FROM stores';
  const params = [];
  if (ONLY_STORE_ID) {
    sql += ' WHERE id = ?';
    params.push(ONLY_STORE_ID);
  }
  sql += ' ORDER BY id';
  const [rows] = await pool.execute(sql, params);
  return rows;
}

function buildMongoPkFilter({ includeStoreFilter = true, includeProductFilter = true } = {}) {
  const mpnFilter = { $regex: '-PK', $options: 'i' };
  const filter = {
    $or: [{ MPN: mpnFilter }, { mpn: mpnFilter }],
  };

  if (includeStoreFilter && ONLY_STORE_ID) {
    filter.$and = [
      {
        $or: [
          { STOREID: ONLY_STORE_ID },
          { STOREID: String(ONLY_STORE_ID) },
          { store_id: ONLY_STORE_ID },
          { store_id: String(ONLY_STORE_ID) },
          { storeid: ONLY_STORE_ID },
          { storeid: String(ONLY_STORE_ID) },
        ],
      },
    ];
  }

  if (includeProductFilter && ONLY_PRODUCT_ID) {
    const extra = {
      $or: [
        { ID: ONLY_PRODUCT_ID },
        { ID: String(ONLY_PRODUCT_ID) },
        { product_id: ONLY_PRODUCT_ID },
        { product_id: String(ONLY_PRODUCT_ID) },
        { id: ONLY_PRODUCT_ID },
        { id: String(ONLY_PRODUCT_ID) },
      ],
    };
    filter.$and = filter.$and ? [...filter.$and, extra] : [extra];
  }

  return filter;
}

// ─── MongoDB ──────────────────────────────────────────────────────────────────
/**
 * Devuelve todos los productos de la colección cuyo MPN contiene "-PK".
 * Agrupa por store_id (normalizado a número).
 */
async function findProductsWithPkMpn(mongoDb) {
  const collection = mongoDb.collection(MONGO_COLLECTION);

  const filter = buildMongoPkFilter();

  const docs = await collection.find(filter).toArray();

  // Normaliza y agrupa por storeId
  const byStore = new Map();
  for (const doc of docs) {
    const storeIdRaw = doc.STOREID ?? doc.store_id ?? doc.storeid;
    const storeId = parseInt(storeIdRaw, 10);
    if (Number.isNaN(storeId)) continue;

    const productIdRaw = doc.ID ?? doc.product_id ?? doc.id;
    const productId = parseInt(productIdRaw, 10);
    if (Number.isNaN(productId)) continue;

    const mpn = doc.MPN ?? doc.mpn ?? '';
    if (!mpn || !/-PK/i.test(mpn)) continue;

    const newMpn = stripPkSuffix(mpn);
    if (newMpn === mpn) continue; // por si acaso

    if (!byStore.has(storeId)) byStore.set(storeId, []);
    byStore.get(storeId).push({
      _id: doc._id,
      productId,
      storeId,
      mpn,
      newMpn,
      sku: doc.SKU ?? doc.sku ?? '',
      mpnField: doc.MPN !== undefined ? 'MPN' : 'mpn',
    });
  }

  return byStore;
}

async function logZeroResultsDiagnostics(mongoDb) {
  const collection = mongoDb.collection(MONGO_COLLECTION);

  const totalPk = await collection.countDocuments(
    buildMongoPkFilter({ includeStoreFilter: false, includeProductFilter: false })
  );

  logger.warn(
    `Diagnóstico: total global con MPN que contiene -PK (sin filtros de store/product): ${totalPk}`
  );

  if (ONLY_STORE_ID || ONLY_PRODUCT_ID) {
    logger.warn(
      'Diagnóstico: hay filtros activos (ONLY_STORE_ID/ONLY_PRODUCT_ID). Pueden excluir resultados reales.'
    );
  }
}

async function updateMpnInMongo(collection, doc) {
  if (DRY_RUN) {
    logger.info(
      `[DRY-RUN] Mongo _id=${doc._id} (store ${doc.storeId}, product ${doc.productId}): ${doc.mpnField} "${doc.mpn}" → "${doc.newMpn}"`
    );
    return true;
  }

  try {
    await collection.updateOne(
      { _id: doc._id },
      { $set: { [doc.mpnField]: doc.newMpn } }
    );
    return true;
  } catch (error) {
    logger.error(`Error Mongo _id=${doc._id}: ${error.message}`);
    stats.errors++;
    return false;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  logger.info('═══════════════════════════════════════════════');
  logger.info(`fixMpnPkSuffix arrancado  DRY_RUN=${DRY_RUN}`);
  if (ONLY_STORE_ID) logger.info(`  ONLY_STORE_ID=${ONLY_STORE_ID}`);
  if (ONLY_PRODUCT_ID) logger.info(`  ONLY_PRODUCT_ID=${ONLY_PRODUCT_ID}`);
  logger.info('═══════════════════════════════════════════════');

  // ── Conexión MongoDB
  const mongoClient = new MongoClient(MONGO_URI);
  await mongoClient.connect();
  const mongoDb = mongoClient.db(MONGO_DB);
  logger.info(`MongoDB conectado: ${MONGO_DB} / colección: ${MONGO_COLLECTION}`);

  let exitCode = 0;

  try {
    // ── Buscar productos con MPN que contenga "-PK"
    const byStore = await findProductsWithPkMpn(mongoDb);
    stats.productsFound = [...byStore.values()].reduce((s, arr) => s + arr.length, 0);
    logger.info(`Productos encontrados con sufijo -PK: ${stats.productsFound}`);

    if (stats.productsFound === 0) {
      logger.info('No hay productos que corregir. Saliendo.');
      await logZeroResultsDiagnostics(mongoDb);
      return;
    }

    // ── Obtener tiendas de MySQL
    const stores = await getStores();
    const storeMap = new Map(stores.map((s) => [s.id, s]));
    logger.info(`Tiendas cargadas desde MySQL: ${stores.map((s) => s.id).join(', ')}`);

    const collection = mongoDb.collection(MONGO_COLLECTION);

    // ── Iterar por tienda
    for (const [storeId, products] of byStore.entries()) {
      const store = storeMap.get(storeId);
      if (!store) {
        logger.warn(`Tienda ${storeId} no encontrada en MySQL. Se omiten ${products.length} productos.`);
        stats.skipped += products.length;
        continue;
      }

      logger.info(
        `── Tienda ${storeId} (${store.name || store.STOREHASH}): ${products.length} producto(s)`
      );

      const bcClient = createBCClient(store.STOREHASH, store.ACCESSTOKEN);

      // Procesar en lotes para no saturar la API de BC
      const batches = chunkArray(products, BC_BATCH_SIZE);
      for (const batch of batches) {
        for (const doc of batch) {
          logger.info(
            `  Producto ${doc.productId} SKU="${doc.sku}" MPN: "${doc.mpn}" → "${doc.newMpn}"`
          );

          // 1. Actualizar MongoDB
          const mongoOk = await updateMpnInMongo(collection, doc);
          if (mongoOk) stats.mongoUpdated++;

          // 2. Actualizar BigCommerce
          const bcOk = await updateMpnInBC(bcClient, doc.productId, doc.newMpn, storeId);
          if (bcOk) stats.bcUpdated++;
        }
        // Pequeña pausa entre lotes para respetar rate limits
        await sleep(300);
      }
    }
  } catch (error) {
    logger.error(`Error fatal: ${error.message}`);
    if (error.stack) logger.error(error.stack);
    stats.errors++;
    exitCode = 1;
  } finally {
    await mongoClient.close();
    logger.info('MongoDB desconectado.');

    logger.info('─── Resumen ────────────────────────────────────');
    logger.info(`  Productos encontrados : ${stats.productsFound}`);
    logger.info(`  MongoDB actualizados  : ${stats.mongoUpdated}`);
    logger.info(`  BigCommerce actulizados: ${stats.bcUpdated}`);
    logger.info(`  Omitidos              : ${stats.skipped}`);
    logger.info(`  Errores               : ${stats.errors}`);
    if (DRY_RUN) logger.info('  *** Modo DRY_RUN: no se escribió nada ***');
    logger.info('────────────────────────────────────────────────');

    process.exit(exitCode);
  }
}

main();
