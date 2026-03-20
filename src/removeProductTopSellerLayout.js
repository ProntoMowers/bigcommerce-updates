'use strict';

/**
 * Script: removeProductTopSellerLayout.js
 *
 * Remueve asociaciones de template custom "product-top-seller" (Stencil)
 * usando Custom Template Associations endpoint y genera un CSV con el detalle
 * de productos modificados por tienda.
 *
 * USO:
 *   node src/removeProductTopSellerLayout.js STORE_CODE [--dry-run]
 *
 * EJEMPLOS:
 *   node src/removeProductTopSellerLayout.js 20
 *   node src/removeProductTopSellerLayout.js all
 *   node src/removeProductTopSellerLayout.js 20 --dry-run
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getMySqlConnection } = require('../providers/dbConnections');
const createLogger = require('../helpers/logger');

const SCRIPT_NAME = 'removeProductTopSellerLayout';
const TARGET_LAYOUT_FILE = 'product-top-seller';
const logger = createLogger(SCRIPT_NAME);

let DRY_RUN = false;

const stats = {
  startTime: null,
  endTime: null,
  storesProcessed: 0,
  productsScanned: 0,
  productsMatched: 0,
  productsUpdated: 0,
  errors: 0,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createBcClient(storeHash, accessToken) {
  const client = axios.create({
    baseURL: `https://api.bigcommerce.com/stores/${storeHash}/v3`,
    headers: {
      'X-Auth-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  client.interceptors.response.use(
    (response) => response,
    async (error) => {
      const config = error.config || {};
      const status = error.response?.status;
      const retryable = [429, 500, 502, 503, 504].includes(status);
      const retries = config.__retryCount || 0;

      if (retryable && retries < 5) {
        config.__retryCount = retries + 1;
        const waitMs = Math.min(1000 * Math.pow(2, config.__retryCount), 12000);
        logger.warn(
          `Reintento BigCommerce (${status}) #${config.__retryCount} en ${waitMs}ms URL=${config.url}`
        );
        await sleep(waitMs);
        return client(config);
      }

      return Promise.reject(error);
    }
  );

  return client;
}

function sanitizeCsvValue(value) {
  if (value === null || value === undefined) return '';
  const str = String(value).replace(/"/g, '""');
  return /[",\n]/.test(str) ? `"${str}"` : str;
}

function initCsvFile() {
  const logDir = path.join(__dirname, '..', 'logs');
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(logDir, `removed_layout_product_top_seller_${stamp}.csv`);

  const headers = [
    'timestamp',
    'store_id',
    'store_name',
    'channel_id',
    'association_id',
    'product_id',
    'sku',
    'name',
    'old_file_name',
    'new_file_name',
    'status',
  ].join(',');

  fs.writeFileSync(filePath, `${headers}\n`, 'utf8');
  return filePath;
}

function appendCsvRow(csvPath, row) {
  const line = [
    new Date().toISOString(),
    row.storeId,
    sanitizeCsvValue(row.storeName),
    sanitizeCsvValue(row.channelId),
    sanitizeCsvValue(row.associationId),
    row.productId,
    sanitizeCsvValue(row.sku),
    sanitizeCsvValue(row.name),
    sanitizeCsvValue(row.oldFileName),
    sanitizeCsvValue(row.newFileName),
    sanitizeCsvValue(row.status),
  ].join(',');

  fs.appendFileSync(csvPath, `${line}\n`, 'utf8');
}

async function getAllStores() {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    `SELECT id, name, STOREHASH, ACCESSTOKEN, ACCESSTOKEN2
     FROM stores
     WHERE STOREHASH IS NOT NULL AND STOREHASH <> ''
       AND ACCESSTOKEN2 IS NOT NULL AND ACCESSTOKEN2 <> ''
     ORDER BY id`
  );
  return rows;
}

async function getStoreById(storeId) {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    `SELECT id, name, STOREHASH, ACCESSTOKEN, ACCESSTOKEN2
     FROM stores
     WHERE id = ?
       AND STOREHASH IS NOT NULL AND STOREHASH <> ''
       AND ACCESSTOKEN IS NOT NULL AND ACCESSTOKEN <> ''
     LIMIT 1`,
    [storeId]
  );
  return rows[0] || null;
}

async function listCustomTemplateAssociationsPage(client, page, limit) {
  const response = await client.get('/storefront/custom-template-associations', {
    params: {
      type: 'product',
      page,
      limit,
    },
  });
  return response.data?.data || [];
}

async function deleteAssociationsByIds(client, ids) {
  if (!ids.length) return;
  await client.delete('/storefront/custom-template-associations', {
    params: {
      'id:in': ids.join(','),
    },
  });
}

async function getProductsMap(client, productIds) {
  const uniqueIds = Array.from(new Set(productIds.filter((id) => Number.isInteger(id))));
  const map = new Map();
  if (!uniqueIds.length) return map;

  const chunkSize = 50;
  for (let i = 0; i < uniqueIds.length; i += chunkSize) {
    const chunk = uniqueIds.slice(i, i + chunkSize);
    const response = await client.get('/catalog/products', {
      params: {
        'id:in': chunk.join(','),
        limit: chunk.length,
        include_fields: 'id,name,sku',
      },
    });

    const rows = response.data?.data || [];
    for (const product of rows) {
      map.set(Number(product.id), {
        sku: product.sku || '',
        name: product.name || '',
      });
    }
  }

  return map;
}

function normalizeLayout(layoutFile) {
  let value = String(layoutFile || '').trim().toLowerCase();
  if (!value) return '';

  value = value.replace(/\\/g, '/');
  const parts = value.split('/').filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : value;

  return last.endsWith('.html') ? last.slice(0, -5) : last;
}

function isTargetLayout(layoutFile) {
  return normalizeLayout(layoutFile) === TARGET_LAYOUT_FILE;
}

async function processStore(store, csvPath) {
  const storeId = Number(store.id);
  const storeName = store.name || '';
  logger.info(`===== Procesando tienda ${storeId} (${storeName}) =====`);

  // Usar ACCESSTOKEN2 (permisos extendidos) si está disponible, si no ACCESSTOKEN
  const accessToken = store.ACCESSTOKEN2 || store.ACCESSTOKEN;
  const tokenSource = store.ACCESSTOKEN2 ? 'ACCESSTOKEN2' : 'ACCESSTOKEN';
  logger.info(`Tienda ${storeId}: usando ${tokenSource}`);

  const client = createBcClient(store.STOREHASH, accessToken);
  let page = 1;
  const limit = 250;
  let scanned = 0;
  let matched = 0;
  let updated = 0;
  const matchedAssociations = [];

  while (true) {
    const associations = await listCustomTemplateAssociationsPage(client, page, limit);
    if (!associations.length) break;

    for (const association of associations) {
      scanned++;
      stats.productsScanned++;

      if (String(association.entity_type || '').toLowerCase() !== 'product') {
        continue;
      }

      if (!isTargetLayout(association.file_name)) {
        continue;
      }

      matched++;
      stats.productsMatched++;
      matchedAssociations.push(association);
    }

    if (associations.length < limit) break;
    page++;
  }

  const productMap = await getProductsMap(
    client,
    matchedAssociations.map((row) => Number(row.entity_id))
  );

  const deleteChunkSize = 50;
  for (let i = 0; i < matchedAssociations.length; i += deleteChunkSize) {
    const chunk = matchedAssociations.slice(i, i + deleteChunkSize);
    const ids = chunk.map((row) => Number(row.id)).filter((id) => Number.isInteger(id));
    if (!ids.length) continue;

    try {
      if (!DRY_RUN) {
        await deleteAssociationsByIds(client, ids);
      }

      for (const association of chunk) {
        const productId = Number(association.entity_id);
        const product = productMap.get(productId) || { sku: '', name: '' };

        updated++;
        stats.productsUpdated++;

        appendCsvRow(csvPath, {
          storeId,
          storeName,
          channelId: association.channel_id,
          associationId: association.id,
          productId,
          sku: product.sku,
          name: product.name,
          oldFileName: association.file_name || '',
          newFileName: '',
          status: DRY_RUN ? 'dry_run_candidate' : 'association_deleted',
        });

        const action = DRY_RUN ? 'sería eliminada' : 'eliminada';
        logger.info(
          `Tienda ${storeId}: asociación ${association.id} ${action} (producto ${productId}, channel ${association.channel_id}, file=${association.file_name || ''})`
        );
      }
    } catch (error) {
      stats.errors++;
      const status = error.response?.status;
      const body = error.response?.data ? JSON.stringify(error.response.data) : '';
      logger.error(
        `Tienda ${storeId}: error eliminando asociaciones [${ids.join(',')}]. status=${status || 'N/A'} message=${error.message} body=${body}`
      );
    }
  }

  stats.storesProcessed++;
  logger.info(
    `Tienda ${storeId} completada. Escaneadas=${scanned}, Coincidencias=${matched}, Eliminadas=${updated}`
  );
}

async function main() {
  stats.startTime = new Date();
  const args = process.argv.slice(2);

  if (!args.length) {
    console.log('Uso: node src/removeProductTopSellerLayout.js STORE_CODE [--dry-run]');
    console.log('');
    console.log('Ejemplos:');
    console.log('  node src/removeProductTopSellerLayout.js 20');
    console.log('  node src/removeProductTopSellerLayout.js all');
    console.log('  node src/removeProductTopSellerLayout.js 20 --dry-run');
    process.exit(1);
  }

  const storeArg = String(args[0]);
  DRY_RUN = args.includes('--dry-run');
  if (storeArg === '--help' || storeArg === '-h') {
    console.log('Uso: node src/removeProductTopSellerLayout.js STORE_CODE [--dry-run]');
    console.log('');
    console.log('Ejemplos:');
    console.log('  node src/removeProductTopSellerLayout.js 20');
    console.log('  node src/removeProductTopSellerLayout.js all');
    console.log('  node src/removeProductTopSellerLayout.js 20 --dry-run');
    return;
  }

  if (storeArg.toLowerCase() !== 'all' && Number.isNaN(parseInt(storeArg, 10))) {
    console.error(`STORE_CODE inválido: ${storeArg}`);
    process.exit(1);
  }

  const csvPath = initCsvFile();

  logger.info('===============================================');
  logger.info(`Script: ${SCRIPT_NAME}.js`);
  logger.info(`Fecha: ${new Date().toISOString()}`);
  logger.info(`Parámetro STORE_CODE=${storeArg}`);
  logger.info(`DRY_RUN=${DRY_RUN ? 'Sí (sin hacer DELETE)' : 'NO'}`);
  logger.info(`Target template association=${TARGET_LAYOUT_FILE}`);
  logger.info(`CSV=${csvPath}`);
  logger.info('===============================================');

  try {
    let stores = [];

    if (storeArg.toLowerCase() === 'all') {
      stores = await getAllStores();
      if (!stores.length) {
        logger.warn('No se encontraron tiendas válidas para procesar.');
        return;
      }
    } else {
      const storeId = parseInt(storeArg, 10);
      if (Number.isNaN(storeId)) {
        throw new Error(`STORE_CODE inválido: ${storeArg}`);
      }
      const store = await getStoreById(storeId);
      if (!store) {
        throw new Error(`No se encontró la tienda ${storeId} o no tiene credenciales BigCommerce.`);
      }
      stores = [store];
    }

    for (const store of stores) {
      try {
        await processStore(store, csvPath);
      } catch (error) {
        stats.errors++;
        logger.error(
          `Error procesando tienda ${store.id}: ${error.message}`
        );
      }
    }
  } catch (error) {
    stats.errors++;
    logger.error(`Error fatal: ${error.message}`);
    process.exitCode = 1;
  } finally {
    stats.endTime = new Date();
    const durationSec = ((stats.endTime - stats.startTime) / 1000).toFixed(2);

    logger.info('');
    logger.info('===============================================');
    logger.info('RESUMEN FINAL');
    logger.info('===============================================');
    logger.info(`Tiendas procesadas: ${stats.storesProcessed}`);
    logger.info(`Asociaciones escaneadas: ${stats.productsScanned}`);
    logger.info(`Asociaciones con template ${TARGET_LAYOUT_FILE}: ${stats.productsMatched}`);
    if (DRY_RUN) {
      logger.info(`Asociaciones candidatas a eliminar: ${stats.productsUpdated}`);
    } else {
      logger.info(`Asociaciones eliminadas: ${stats.productsUpdated}`);
    }
    logger.info(`Errores: ${stats.errors}`);
    logger.info(`Duración (s): ${durationSec}`);
    logger.info(`CSV generado: ${csvPath}`);
    if (DRY_RUN) {
      logger.info('⚠️  MODO DRY-RUN: No se eliminó nada. Revisa el CSV para validar.');
    }
    logger.info('===============================================');

    console.log(`CSV generado: ${csvPath}`);
  }
}

main();
