'use strict';

/**
 * Script: updateCustomFieldsInventoryTop.js
 *
 * Sincronización de Custom Fields __inv, __topseller y __badge en BigCommerce
 *
 * USO:
 *    node src/updateCustomFieldsInventoryTop.js STORE_CODE [PRODUCT_ID]
 *
 * Ejemplos:
 *    node src/updateCustomFieldsInventoryTop.js 20
 *    node src/updateCustomFieldsInventoryTop.js 20 123
 *    node src/updateCustomFieldsInventoryTop.js all
 *    node src/updateCustomFieldsInventoryTop.js all 123
 */

require('dotenv').config();
const axios = require('axios');
const { getMySqlConnection } = require('../providers/dbConnections');
const createLogger = require('../helpers/logger');

const SCRIPT_NAME = 'updateCustomFieldsInventoryTop';
const logger = createLogger(SCRIPT_NAME);

// Configuración de la API de Parts Availability
const API_BASE_URL = process.env.API_URL || 'https://prontoweb-api.ngrok.app';
const PARTS_API_URL = process.env.PARTS_API_URL || `${API_BASE_URL}/v1/parts/availability/resolve`;
const PARTS_API_KEY = process.env.PARTS_AVAILABILITY_API_KEY || process.env.PARTS_API_KEY || '';
const LOCATION_ID = 4; // Siempre usar locationId = 4
const BATCH_SIZE = 50; // Máximo de productos por request
const BC_MAX_RETRIES = parseInt(process.env.BC_MAX_RETRIES || '5', 10);
const MONGO_MAX_RETRIES = parseInt(process.env.MONGO_MAX_RETRIES || '5', 10);
const RETRY_BASE_DELAY_MS = parseInt(process.env.RETRY_BASE_DELAY_MS || '500', 10);
const VERBOSE_LOGS = process.env.VERBOSE_LOGS === '1';
const LOG_MEMORY = process.env.LOG_MEMORY === '1';

// MongoDB - será necesario instalar mongodb
let mongoClient;
let mongoDb;

// Estadísticas globales
const stats = {
  totalStores: 0,
  totalProducts: 0,
  productsWithInventory: 0,
  productsAB: 0,
  productsSpecial: 0,
  customFieldsCreated: { __inv: 0, __topseller: 0, __badge: 0 },
  customFieldsUpdated: { __inv: 0, __topseller: 0, __badge: 0 },
  customFieldsDeleted: { __inv: 0, __topseller: 0, __badge: 0 },
  errors: 0,
  startTime: null,
  endTime: null,
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getBackoffMs(attempt) {
  return Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), 10000);
}

function verboseInfo(message) {
  if (VERBOSE_LOGS) {
    logger.info(message);
  }
}

function isRetryableNetworkError(error) {
  const code = error?.code;
  return ['ECONNRESET', 'ETIMEDOUT', 'ESOCKETTIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code);
}

function isRetryableHttpStatus(status) {
  return [408, 409, 429, 500, 502, 503, 504].includes(status);
}

function isRetryableMongoError(error) {
  if (!error) return false;
  if (isRetryableNetworkError(error)) return true;

  const name = error.name || '';
  return name === 'MongoNetworkError' || name === 'MongoServerSelectionError' || name === 'MongoNetworkTimeoutError';
}

// ============================================
// MONGODB CONNECTION
// ============================================
async function connectMongoDB() {
  const { MongoClient } = require('mongodb');
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  const mongoDbName = process.env.MONGO_DB || 'Prontoweb';

  mongoClient = new MongoClient(mongoUri, {
    maxPoolSize: 20,
    minPoolSize: 2,
    connectTimeoutMS: 15000,
    socketTimeoutMS: 60000,
    serverSelectionTimeoutMS: 15000,
    retryReads: true,
  });
  await mongoClient.connect();
  mongoDb = mongoClient.db(mongoDbName);
  logger.info(`Conectado a MongoDB: ${mongoDbName}`);
}

async function closeMongoDB() {
  if (mongoClient) {
    await mongoClient.close();
    logger.info('Conexión a MongoDB cerrada');
  }
}

// ============================================
// MYSQL QUERIES
// ============================================
async function getAllStores() {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute('SELECT id, STOREHASH, ACCESSTOKEN, name FROM stores ORDER BY id');
  return rows;
}

async function getStoreById(storeId) {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    'SELECT id, STOREHASH, ACCESSTOKEN, name FROM stores WHERE id = ?',
    [storeId]
  );
  return rows[0] || null;
}

async function getProductABC(mfr, partnumber) {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    'SELECT clasif_completo FROM products_abc WHERE mfr = ? AND partnumber = ? LIMIT 1',
    [mfr, partnumber]
  );
  return rows[0] || null;
}

async function isSpecialProduct(brand, sku) {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    `SELECT 1 FROM special_products 
     WHERE brand = ? AND sku = ? 
     AND (end_date IS NULL OR end_date = '' OR end_date > NOW())
     LIMIT 1`,
    [brand, sku]
  );
  return rows.length > 0;
}

// ============================================
// MONGODB QUERIES
// ============================================
function normalizeLookupValue(value) {
  return String(value || '').trim().toLowerCase();
}

function buildPartsLookupKey(item) {
  const mpn = normalizeLookupValue(item?.mpn);
  if (mpn) return `mpn:${mpn}`;

  const sku = normalizeLookupValue(item?.sku);
  if (sku) return `sku:${sku}`;

  return '';
}

function getMongoProductsCursor(storeId, productId = null) {
  const collectionName = process.env.MONGO_PRODUCTS_COLLECTION || 'Products';
  const collection = mongoDb.collection(collectionName);
  const storeIdNum = parseInt(storeId, 10);
  const query = {
    $or: [
      { STOREID: storeIdNum },
      { STOREID: String(storeIdNum) },
      { store_id: storeIdNum },
      { store_id: String(storeIdNum) },
    ],
  };

  if (productId) {
    const productIdNum = parseInt(productId, 10);
    query.$and = [
      {
        $or: [
          { ID: productIdNum },
          { ID: String(productIdNum) },
          { product_id: productIdNum },
          { product_id: String(productIdNum) },
        ],
      },
    ];
  }

  return collection.find(query, {
    projection: {
      _id: 1,
      ID: 1,
      product_id: 1,
      BRAND: 1,
      brand: 1,
      SKU: 1,
      sku: 1,
      MPN: 1,
      mpn: 1,
    },
    sort: { _id: 1 },
    batchSize: BATCH_SIZE,
  });
}

function mapMongoProduct(p) {
  const idRaw = p.ID ?? p.product_id;
  const id = parseInt(idRaw, 10);
  if (Number.isNaN(id)) return null;

  return {
    mongoId: p._id,
    id,
    brand: p.BRAND || p.brand || '',
    sku: p.SKU || p.sku || '',
    mpn: p.MPN || p.mpn || '',
  };
}

async function* getMongoProductsBatches(storeId, productId = null, batchSize = BATCH_SIZE) {
  let cursor = getMongoProductsCursor(storeId, productId);
  let retries = 0;
  let lastMongoId = null;
  let batch = [];

  while (true) {
    try {
      for await (const rawDoc of cursor) {
        const mapped = mapMongoProduct(rawDoc);
        lastMongoId = rawDoc?._id || lastMongoId;
        if (!mapped) continue;

        batch.push(mapped);
        if (batch.length >= batchSize) {
          yield batch;
          batch = [];
        }
      }

      break;
    } catch (error) {
      if (!isRetryableMongoError(error) || retries >= MONGO_MAX_RETRIES) {
        throw error;
      }

      retries++;
      const waitMs = getBackoffMs(retries);
      logger.warn(
        `Mongo cursor retry ${retries}/${MONGO_MAX_RETRIES} para tienda ${storeId} en ${waitMs}ms: ${error.message}`
      );
      await sleep(waitMs);

      const collectionName = process.env.MONGO_PRODUCTS_COLLECTION || 'Products';
      const collection = mongoDb.collection(collectionName);
      const storeIdNum = parseInt(storeId, 10);
      const query = {
        $or: [
          { STOREID: storeIdNum },
          { STOREID: String(storeIdNum) },
          { store_id: storeIdNum },
          { store_id: String(storeIdNum) },
        ],
      };

      if (productId) {
        const productIdNum = parseInt(productId, 10);
        query.$and = [
          {
            $or: [
              { ID: productIdNum },
              { ID: String(productIdNum) },
              { product_id: productIdNum },
              { product_id: String(productIdNum) },
            ],
          },
        ];
      }

      if (lastMongoId) {
        query._id = { $gt: lastMongoId };
      }

      cursor = collection.find(query, {
        projection: {
          _id: 1,
          ID: 1,
          product_id: 1,
          BRAND: 1,
          brand: 1,
          SKU: 1,
          sku: 1,
          MPN: 1,
          mpn: 1,
        },
        sort: { _id: 1 },
        batchSize,
      });
    }
  }

  if (batch.length) {
    yield batch;
  }
}

function logMemoryUsage(context) {
  if (!LOG_MEMORY) return;
  const mem = process.memoryUsage();
  const rssMb = (mem.rss / 1024 / 1024).toFixed(1);
  const heapUsedMb = (mem.heapUsed / 1024 / 1024).toFixed(1);
  const heapTotalMb = (mem.heapTotal / 1024 / 1024).toFixed(1);
  logger.info(`[MEM] ${context} rss=${rssMb}MB heapUsed=${heapUsedMb}MB heapTotal=${heapTotalMb}MB`);
}

async function bcRequest(client, config, label) {
  for (let attempt = 1; attempt <= BC_MAX_RETRIES + 1; attempt++) {
    try {
      return await client.request(config);
    } catch (error) {
      const status = error.response?.status;
      const retryable = isRetryableNetworkError(error) || isRetryableHttpStatus(status);
      const hasNext = attempt <= BC_MAX_RETRIES;

      if (!retryable || !hasNext) {
        throw error;
      }

      const waitMs = getBackoffMs(attempt);
      logger.warn(
        `BigCommerce retry ${attempt}/${BC_MAX_RETRIES} (${label}) en ${waitMs}ms status=${status || 'N/A'} err=${error.message}`
      );
      await sleep(waitMs);
    }
  }
}

// ============================================
// BIGCOMMERCE API
// ============================================
function createBCClient(storeHash, accessToken) {
  return axios.create({
    baseURL: `https://api.bigcommerce.com/stores/${storeHash}/v3`,
    headers: {
      'X-Auth-Token': accessToken,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    timeout: 30000,
  });
}

async function getProductDetails(client, productId) {
  try {
    const response = await bcRequest(
      client,
      { method: 'GET', url: `/catalog/products/${productId}?include=custom_fields` },
      `getProductDetails product=${productId}`
    );
    return response.data.data;
  } catch (error) {
    logger.error(`Error obteniendo producto ${productId}: ${error.message}`);
    return null;
  }
}

async function getProductsDetailsBatch(client, productIds) {
  const products = [];
  
  // BigCommerce permite obtener productos en batch usando filtros
  // Dividimos en grupos de 50
  for (let i = 0; i < productIds.length; i += 50) {
    const batch = productIds.slice(i, i + 50);
    const idsParam = batch.join(',');
    
    try {
      const response = await bcRequest(
        client,
        { method: 'GET', url: `/catalog/products?id:in=${idsParam}&include=custom_fields&limit=50` },
        `getProductsDetailsBatch ids=${idsParam}`
      );
      if (response.data.data) {
        products.push(...response.data.data);
      }
    } catch (error) {
      logger.error(`Error obteniendo batch de productos: ${error.message}`);
      // Intentar uno por uno en caso de error
      for (const id of batch) {
        const product = await getProductDetails(client, id);
        if (product) products.push(product);
      }
    }
  }
  
  return products;
}

async function getCustomFields(client, productId) {
  try {
    const response = await bcRequest(
      client,
      { method: 'GET', url: `/catalog/products/${productId}/custom-fields` },
      `getCustomFields product=${productId}`
    );
    return response.data.data || [];
  } catch (error) {
    logger.error(`Error obteniendo custom fields del producto ${productId}: ${error.message}`);
    return [];
  }
}

async function createCustomField(client, productId, name, value) {
  try {
    await bcRequest(
      client,
      { method: 'POST', url: `/catalog/products/${productId}/custom-fields`, data: { name, value } },
      `createCustomField product=${productId} field=${name}`
    );
    verboseInfo(`Custom field ${name} creado para producto ${productId}`);
    return true;
  } catch (error) {
    logger.error(`Error creando custom field ${name} para producto ${productId}: ${error.message}`);
    stats.errors++;
    return false;
  }
}

async function updateCustomField(client, productId, fieldId, value) {
  try {
    await bcRequest(
      client,
      { method: 'PUT', url: `/catalog/products/${productId}/custom-fields/${fieldId}`, data: { value } },
      `updateCustomField product=${productId} fieldId=${fieldId}`
    );
    verboseInfo(`Custom field ID ${fieldId} actualizado para producto ${productId}`);
    return true;
  } catch (error) {
    logger.error(`Error actualizando custom field ${fieldId} para producto ${productId}: ${error.message}`);
    stats.errors++;
    return false;
  }
}

async function deleteCustomField(client, productId, fieldId) {
  try {
    await bcRequest(
      client,
      { method: 'DELETE', url: `/catalog/products/${productId}/custom-fields/${fieldId}` },
      `deleteCustomField product=${productId} fieldId=${fieldId}`
    );
    verboseInfo(`Custom field ID ${fieldId} eliminado para producto ${productId}`);
    return true;
  } catch (error) {
    logger.error(`Error eliminando custom field ${fieldId} para producto ${productId}: ${error.message}`);
    stats.errors++;
    return false;
  }
}

// ============================================
// PARTS AVAILABILITY API
// ============================================
async function getPartsAvailability(storeId, products) {
  // Preparar el payload
  const productsPayload = products.map(p => {
    const product = {
      brand: p.brand_name || '',
    };
    
    // Priorizar mpn sobre sku
    if (p.mpn) {
      product.mpn = p.mpn;
    } else {
      product.sku = p.sku;
    }
    
    return product;
  });
  
  const payload = {
    storeId: parseInt(storeId),
    locationId: LOCATION_ID,
    products: productsPayload,
  };

  verboseInfo(
    `Parts API payload -> storeId=${payload.storeId}, locationId=${payload.locationId}, products=${payload.products.length}`
  );
  if (VERBOSE_LOGS) {
    productsPayload.slice(0, 3).forEach((p, idx) => {
      logger.info(`Parts API item[${idx}] brand="${p.brand}" sku="${p.sku || ''}" mpn="${p.mpn || ''}"`);
    });
  }
  
  try {
    const response = await axios.post(PARTS_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': PARTS_API_KEY,
      },
      timeout: 60000,
    });
    
    return response.data.results || [];
  } catch (error) {
    const status = error.response?.status;
    logger.error(`Error consultando Parts Availability API: ${error.message}`);
    if (error.response?.data) {
      logger.error(`Parts API response body: ${JSON.stringify(error.response.data)}`);
    }
    stats.errors++;

    // Error de autenticación: abortar para evitar cambios incorrectos en custom fields
    if (status === 401 || status === 403) {
      throw new Error(
        `Parts Availability API respondió ${status}. Verifica PARTS_API_KEY/PARTS_AVAILABILITY_API_KEY en .env.`
      );
    }

    return [];
  }
}

// ============================================
// BUSINESS LOGIC
// ============================================
async function calculateCustomFieldValues(product, partsData, storeId) {
  const values = {
    __inv: null,
    __topseller: null,
    __badge: null,
  };
  
  // 1. __badge - basado en is_free_shipping
  const hasFreeShipping = product.is_free_shipping === true;
  verboseInfo(
    `Producto ${product.id} (${product.sku}): is_free_shipping=${String(product.is_free_shipping)} -> ${hasFreeShipping ? '__badge=Free Shipping' : '__badge=(sin valor)'}`
  );
  if (hasFreeShipping) {
    values.__badge = 'Free Shipping';
  }
  
  // 2. Verificar si es producto especial
  const isSpecial = await isSpecialProduct(product.brand_name || '', product.sku || '');
  
  if (isSpecial) {
    // Productos especiales tienen prioridad
    values.__inv = 'Y';
    values.__topseller = 'Y';
    stats.productsSpecial++;
    verboseInfo(`Producto ${product.id} (${product.sku}) es especial - forzando __inv y __topseller`);
    return values;
  }
  
  // 3. Obtener datos de IDEAL desde Parts Availability
  if (!partsData) {
    verboseInfo(`No hay datos de Parts Availability para producto ${product.id} (${product.sku})`);
    return values;
  }
  
  const mfridIdeal = partsData.match?.mfridIdeal;
  const partNumberIdeal = partsData.match?.partNumberIdeal;
  const onHandAvailability = partsData.inventory?.onHandAvailability || 0;
  
  // 4. __inv - basado en inventario
  if (onHandAvailability > 0) {
    values.__inv = 'Y';
    stats.productsWithInventory++;
  }
  
  // 5. __topseller - basado en clasificación ABC
  if (mfridIdeal && partNumberIdeal) {
    const abc = await getProductABC(mfridIdeal, partNumberIdeal);
    if (abc && (abc.clasif_completo === 'A' || abc.clasif_completo === 'B')) {
      values.__topseller = 'Y';
      stats.productsAB++;
      verboseInfo(`Producto ${product.id} (${product.sku}) clasificación: ${abc.clasif_completo}`);
    }
  }
  
  return values;
}

async function syncCustomFields(client, product, desiredValues) {
  const currentFields = product.custom_fields || [];
  const fieldsToSync = ['__inv', '__topseller', '__badge'];
  
  for (const fieldName of fieldsToSync) {
    const desiredValue = desiredValues[fieldName];
    const existingField = currentFields.find(f => f.name === fieldName);
    
    if (desiredValue) {
      // El campo debe existir con este valor
      if (existingField) {
        // Ya existe - verificar si necesita actualización
        if (existingField.value !== desiredValue) {
          const success = await updateCustomField(client, product.id, existingField.id, desiredValue);
          if (success) stats.customFieldsUpdated[fieldName]++;
        } else {
          verboseInfo(`Custom field ${fieldName} ya tiene el valor correcto para producto ${product.id}`);
        }
      } else {
        // No existe - crear
        const success = await createCustomField(client, product.id, fieldName, desiredValue);
        if (success) stats.customFieldsCreated[fieldName]++;
      }
    } else {
      // El campo NO debe existir
      if (existingField) {
        // Existe pero no debería - eliminar
        const success = await deleteCustomField(client, product.id, existingField.id);
        if (success) stats.customFieldsDeleted[fieldName]++;
      }
    }
  }
}

// ============================================
// MAIN PROCESS
// ============================================
async function processStore(storeId, productId = null) {
  const storeStart = Date.now();
  logger.info(`===== Procesando tienda ${storeId} =====`);
  
  // 1. Obtener credenciales de la tienda
  const store = await getStoreById(storeId);
  if (!store) {
    logger.error(`Tienda ${storeId} no encontrada en la base de datos`);
    return;
  }
  
  logger.info(`Tienda ${storeId}: ${store.name} (${store.STOREHASH})`);
  
  // 2. Crear cliente de BigCommerce
  const bcClient = createBCClient(store.STOREHASH, store.ACCESSTOKEN);

  // 3. Obtener y procesar productos desde MongoDB por lotes (evita OOM)
  let totalMongoProducts = 0;
  let batchNumber = 0;
  for await (const mongoBatch of getMongoProductsBatches(storeId, productId, BATCH_SIZE)) {
    batchNumber++;
    totalMongoProducts += mongoBatch.length;
    stats.totalProducts += mongoBatch.length;

    logger.info(`Tienda ${storeId} - lote ${batchNumber}: ${mongoBatch.length} producto(s) desde MongoDB`);

    const productIds = mongoBatch.map((p) => p.id);
    const mongoProductsById = new Map(mongoBatch.map((p) => [p.id, p]));

    // 4. Obtener detalles de productos desde BigCommerce para este lote
    const products = await getProductsDetailsBatch(bcClient, productIds);
    logger.info(`Tienda ${storeId} - lote ${batchNumber}: detalles BigCommerce obtenidos=${products.length}`);

    if (!products.length) {
      logMemoryUsage(`store=${storeId} lote=${batchNumber} (sin detalles BC)`);
      continue;
    }

    // 5. Consultar Parts Availability API
    const batchForParts = products.map((product) => {
      const mongoProduct = mongoProductsById.get(product.id);
      return {
        ...product,
        brand_name: product.brand_name || mongoProduct?.brand || '',
        mpn: product.mpn || mongoProduct?.mpn || '',
        sku: product.sku || mongoProduct?.sku || '',
      };
    });

    const partsResults = await getPartsAvailability(storeId, batchForParts);

    // Crear mapa por llave normalizada (mpn/sku)
    const partsMap = new Map();
    partsResults.forEach((result) => {
      const key = buildPartsLookupKey({
        mpn: result?.input?.mpn,
        sku: result?.input?.sku,
      });
      if (key) partsMap.set(key, result);
    });

    // 6. Procesar cada producto del lote
    let skippedNoPartsInBatch = 0;
    for (const product of batchForParts) {
      try {
        const lookupKey = buildPartsLookupKey({ mpn: product.mpn, sku: product.sku });
        const partsData = lookupKey ? partsMap.get(lookupKey) : null;

        // Fail-safe: si no hay data de Parts para el producto, no hacer cambios
        if (!partsData) {
          skippedNoPartsInBatch++;
          verboseInfo(
            `Producto ${product.id} (${product.sku || product.mpn || 'sin-sku-mpn'}): sin data de Parts Availability, se omite sin cambios.`
          );
          continue;
        }

        // 8. Calcular valores deseados para custom fields
        const desiredValues = await calculateCustomFieldValues(product, partsData, storeId);

        // 9. Sincronizar custom fields
        await syncCustomFields(bcClient, product, desiredValues);
      } catch (error) {
        logger.error(`Error procesando producto ${product.id}: ${error.message}`);
        stats.errors++;
      }
    }

    if (skippedNoPartsInBatch > 0) {
      logger.info(
        `Tienda ${storeId} - lote ${batchNumber}: omitidos_sin_parts=${skippedNoPartsInBatch}`
      );
    }

    if (batchNumber % 25 === 0) {
      logger.info(
        `Tienda ${storeId}: progreso parcial -> lotes=${batchNumber}, productos_procesados=${totalMongoProducts}, errores=${stats.errors}`
      );
    }

    logMemoryUsage(`store=${storeId} lote=${batchNumber}`);
  }

  if (totalMongoProducts === 0) {
    logger.warn(`No hay productos en MongoDB para tienda ${storeId}`);
    return;
  }

  const storeDurationSec = ((Date.now() - storeStart) / 1000).toFixed(2);
  logger.info(`Tienda ${storeId}: total de productos procesados desde MongoDB=${totalMongoProducts}`);
  logger.info(`Tienda ${storeId}: tiempo total=${storeDurationSec}s`);
  
  logger.info(`===== Tienda ${storeId} completada =====`);
}

async function main() {
  stats.startTime = new Date();

  if (
    !PARTS_API_KEY ||
    PARTS_API_KEY === 'your_secure_api_key_here' ||
    PARTS_API_KEY === 'tu_api_key'
  ) {
    logger.error('PARTS_API_KEY no está configurada correctamente en .env.');
    logger.error('Define PARTS_API_KEY (o PARTS_AVAILABILITY_API_KEY) con un valor real.');
    process.exit(1);
  }
  
  // Validar argumentos
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.log('Uso: node src/updateCustomFieldsInventoryTop.js STORE_CODE [PRODUCT_ID]');
    console.log('');
    console.log('Ejemplos:');
    console.log('  node src/updateCustomFieldsInventoryTop.js 20');
    console.log('  node src/updateCustomFieldsInventoryTop.js 20 123');
    console.log('  node src/updateCustomFieldsInventoryTop.js all');
    console.log('  node src/updateCustomFieldsInventoryTop.js all 123');
    process.exit(1);
  }
  
  const storeCode = args[0];
  const productId = args[1] ? parseInt(args[1]) : null;
  
  logger.info('===============================================');
  logger.info('Script: updateCustomFieldsInventoryTop.js');
  logger.info(`Fecha: ${new Date().toISOString()}`);
  logger.info(`Parámetros: STORE_CODE=${storeCode}, PRODUCT_ID=${productId || 'N/A'}`);
  logger.info(`Parts API URL: ${PARTS_API_URL}`);
  logger.info('===============================================');
  
  try {
    // Conectar a MongoDB
    await connectMongoDB();
    
    // Determinar qué tiendas procesar
    let storesToProcess = [];
    
    if (storeCode.toLowerCase() === 'all') {
      logger.info('Procesando TODAS las tiendas...');
      const allStores = await getAllStores();
      storesToProcess = allStores.map(s => s.id);
      stats.totalStores = storesToProcess.length;
      logger.info(`Total de tiendas a procesar: ${stats.totalStores}`);
    } else {
      const storeId = parseInt(storeCode);
      if (isNaN(storeId)) {
        logger.error(`STORE_CODE inválido: ${storeCode}`);
        process.exit(1);
      }
      storesToProcess = [storeId];
      stats.totalStores = 1;
    }
    
    // Procesar cada tienda
    for (let index = 0; index < storesToProcess.length; index++) {
      const storeId = storesToProcess[index];
      logger.info(`>>> Inicio tienda ${storeId} (${index + 1}/${storesToProcess.length})`);
      await processStore(storeId, productId);
      logger.info(`<<< Fin tienda ${storeId} (${index + 1}/${storesToProcess.length})`);
    }
    
    // Resumen final
    stats.endTime = new Date();
    const duration = (stats.endTime - stats.startTime) / 1000;
    
    logger.info('');
    logger.info('===============================================');
    logger.info('RESUMEN FINAL');
    logger.info('===============================================');
    logger.info(`Tiendas procesadas: ${stats.totalStores}`);
    logger.info(`Productos analizados: ${stats.totalProducts}`);
    logger.info(`Productos con inventario: ${stats.productsWithInventory}`);
    logger.info(`Productos A/B: ${stats.productsAB}`);
    logger.info(`Productos especiales: ${stats.productsSpecial}`);
    logger.info('');
    logger.info('Custom Fields Creados:');
    logger.info(`  __inv: ${stats.customFieldsCreated.__inv}`);
    logger.info(`  __topseller: ${stats.customFieldsCreated.__topseller}`);
    logger.info(`  __badge: ${stats.customFieldsCreated.__badge}`);
    logger.info('');
    logger.info('Custom Fields Actualizados:');
    logger.info(`  __inv: ${stats.customFieldsUpdated.__inv}`);
    logger.info(`  __topseller: ${stats.customFieldsUpdated.__topseller}`);
    logger.info(`  __badge: ${stats.customFieldsUpdated.__badge}`);
    logger.info('');
    logger.info('Custom Fields Eliminados:');
    logger.info(`  __inv: ${stats.customFieldsDeleted.__inv}`);
    logger.info(`  __topseller: ${stats.customFieldsDeleted.__topseller}`);
    logger.info(`  __badge: ${stats.customFieldsDeleted.__badge}`);
    logger.info('');
    logger.info(`Errores: ${stats.errors}`);
    logger.info(`Duración total: ${duration.toFixed(2)} segundos`);
    logger.info(`Resumen ejecución: productos procesados=${stats.totalProducts}, tiempo=${duration.toFixed(2)}s`);
    logger.info('===============================================');
    
  } catch (error) {
    logger.error(`Error fatal: ${error.message}`);
    logger.error(error.stack);
    process.exit(1);
  } finally {
    await closeMongoDB();
  }
}

// Ejecutar
main();
