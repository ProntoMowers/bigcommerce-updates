'use strict';

/**
 * Script: updateCustomFieldsInventoryTop.js
 *
 * Sincronización de Custom Fields __inv, __top y __badge en BigCommerce
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
const PARTS_API_URL = process.env.PARTS_API_URL || 'http://10.1.10.21:3001/v1/parts/availability/resolve';
const PARTS_API_KEY = process.env.PARTS_API_KEY || '';
const LOCATION_ID = 4; // Siempre usar locationId = 4
const BATCH_SIZE = 50; // Máximo de productos por request

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
  customFieldsCreated: { __inv: 0, __top: 0, __badge: 0 },
  customFieldsUpdated: { __inv: 0, __top: 0, __badge: 0 },
  customFieldsDeleted: { __inv: 0, __top: 0, __badge: 0 },
  errors: 0,
  startTime: null,
  endTime: null,
};

// ============================================
// MONGODB CONNECTION
// ============================================
async function connectMongoDB() {
  const { MongoClient } = require('mongodb');
  const mongoUri = process.env.MONGO_URI || 'mongodb://localhost:27017';
  const mongoDbName = process.env.MONGO_DB || 'Prontoweb';
  
  mongoClient = new MongoClient(mongoUri);
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
async function getProductsFromMongo(storeId, productId = null) {
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

  const products = await collection.find(query).toArray();
  logger.info(`MongoDB: ${products.length} productos encontrados para tienda ${storeId}`);
  return products
    .map((p) => {
      const idRaw = p.ID ?? p.product_id;
      const id = parseInt(idRaw, 10);
      if (Number.isNaN(id)) return null;

      return {
        id,
        brand: p.BRAND || p.brand || '',
        sku: p.SKU || p.sku || '',
        mpn: p.MPN || p.mpn || '',
      };
    })
    .filter((p) => p !== null);
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
    const response = await client.get(`/catalog/products/${productId}?include=custom_fields`);
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
      const response = await client.get(`/catalog/products?id:in=${idsParam}&include=custom_fields&limit=50`);
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
    const response = await client.get(`/catalog/products/${productId}/custom-fields`);
    return response.data.data || [];
  } catch (error) {
    logger.error(`Error obteniendo custom fields del producto ${productId}: ${error.message}`);
    return [];
  }
}

async function createCustomField(client, productId, name, value) {
  try {
    await client.post(`/catalog/products/${productId}/custom-fields`, { name, value });
    logger.info(`Custom field ${name} creado para producto ${productId}`);
    return true;
  } catch (error) {
    logger.error(`Error creando custom field ${name} para producto ${productId}: ${error.message}`);
    stats.errors++;
    return false;
  }
}

async function updateCustomField(client, productId, fieldId, value) {
  try {
    await client.put(`/catalog/products/${productId}/custom-fields/${fieldId}`, { value });
    logger.info(`Custom field ID ${fieldId} actualizado para producto ${productId}`);
    return true;
  } catch (error) {
    logger.error(`Error actualizando custom field ${fieldId} para producto ${productId}: ${error.message}`);
    stats.errors++;
    return false;
  }
}

async function deleteCustomField(client, productId, fieldId) {
  try {
    await client.delete(`/catalog/products/${productId}/custom-fields/${fieldId}`);
    logger.info(`Custom field ID ${fieldId} eliminado para producto ${productId}`);
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

  logger.info(
    `Parts API payload -> storeId=${payload.storeId}, locationId=${payload.locationId}, products=${payload.products.length}`
  );
  productsPayload.slice(0, 3).forEach((p, idx) => {
    logger.info(`Parts API item[${idx}] brand="${p.brand}" sku="${p.sku || ''}" mpn="${p.mpn || ''}"`);
  });
  
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
    logger.error(`Error consultando Parts Availability API: ${error.message}`);
    if (error.response?.data) {
      logger.error(`Parts API response body: ${JSON.stringify(error.response.data)}`);
    }
    stats.errors++;
    return [];
  }
}

// ============================================
// BUSINESS LOGIC
// ============================================
async function calculateCustomFieldValues(product, partsData, storeId) {
  const values = {
    __inv: null,
    __top: null,
    __badge: null,
  };
  
  // 1. __badge - basado en is_free_shipping
  const hasFreeShipping = product.is_free_shipping === true;
  logger.info(
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
    values.__top = 'Y';
    stats.productsSpecial++;
    logger.info(`Producto ${product.id} (${product.sku}) es especial - forzando __inv y __top`);
    return values;
  }
  
  // 3. Obtener datos de IDEAL desde Parts Availability
  if (!partsData) {
    logger.warn(`No hay datos de Parts Availability para producto ${product.id} (${product.sku})`);
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
  
  // 5. __top - basado en clasificación ABC
  if (mfridIdeal && partNumberIdeal) {
    const abc = await getProductABC(mfridIdeal, partNumberIdeal);
    if (abc && (abc.clasif_completo === 'A' || abc.clasif_completo === 'B')) {
      values.__top = 'Y';
      stats.productsAB++;
      logger.info(`Producto ${product.id} (${product.sku}) clasificación: ${abc.clasif_completo}`);
    }
  }
  
  return values;
}

async function syncCustomFields(client, product, desiredValues) {
  const currentFields = product.custom_fields || [];
  const fieldsToSync = ['__inv', '__top', '__badge'];
  
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
          logger.info(`Custom field ${fieldName} ya tiene el valor correcto para producto ${product.id}`);
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
  logger.info(`===== Procesando tienda ${storeId} =====`);
  
  // 1. Obtener credenciales de la tienda
  const store = await getStoreById(storeId);
  if (!store) {
    logger.error(`Tienda ${storeId} no encontrada en la base de datos`);
    return;
  }
  
  logger.info(`Tienda: ${store.name} (${store.STOREHASH})`);
  
  // 2. Crear cliente de BigCommerce
  const bcClient = createBCClient(store.STOREHASH, store.ACCESSTOKEN);
  
  // 3. Obtener productos desde MongoDB
  const mongoProducts = await getProductsFromMongo(storeId, productId);
  if (mongoProducts.length === 0) {
    logger.warn(`No hay productos en MongoDB para tienda ${storeId}`);
    return;
  }

  const productIds = mongoProducts.map((p) => p.id);
  const mongoProductsById = new Map(mongoProducts.map((p) => [p.id, p]));
  
  stats.totalProducts += productIds.length;
  logger.info(`Total de productos a procesar: ${productIds.length}`);
  
  // 4. Obtener detalles de productos desde BigCommerce
  logger.info('Obteniendo detalles de productos desde BigCommerce...');
  const products = await getProductsDetailsBatch(bcClient, productIds);
  logger.info(`Detalles obtenidos: ${products.length} productos`);
  
  // 5. Procesar en lotes de 50 para Parts Availability API
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    logger.info(`Procesando lote ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(products.length / BATCH_SIZE)}`);
    
    // 6. Consultar Parts Availability API
    const batchForParts = batch.map((product) => {
      const mongoProduct = mongoProductsById.get(product.id);
      return {
        ...product,
        brand_name: product.brand_name || mongoProduct?.brand || '',
        mpn: product.mpn || mongoProduct?.mpn || '',
        sku: product.sku || mongoProduct?.sku || '',
      };
    });

    const partsResults = await getPartsAvailability(storeId, batchForParts);
    
    // Crear un mapa para búsqueda rápida
    const partsMap = new Map();
    partsResults.forEach(result => {
      const key = result.input?.mpn || result.input?.sku;
      if (key) partsMap.set(key, result);
    });
    
    // 7. Procesar cada producto del lote
    for (const product of batch) {
      try {
        const lookupKey = product.mpn || product.sku;
        const partsData = partsMap.get(lookupKey);
        
        // 8. Calcular valores deseados para custom fields
        const desiredValues = await calculateCustomFieldValues(product, partsData, storeId);
        
        // 9. Sincronizar custom fields
        await syncCustomFields(bcClient, product, desiredValues);
        
      } catch (error) {
        logger.error(`Error procesando producto ${product.id}: ${error.message}`);
        stats.errors++;
      }
    }
  }
  
  logger.info(`===== Tienda ${storeId} completada =====`);
}

async function main() {
  stats.startTime = new Date();
  
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
    for (const storeId of storesToProcess) {
      await processStore(storeId, productId);
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
    logger.info(`  __top: ${stats.customFieldsCreated.__top}`);
    logger.info(`  __badge: ${stats.customFieldsCreated.__badge}`);
    logger.info('');
    logger.info('Custom Fields Actualizados:');
    logger.info(`  __inv: ${stats.customFieldsUpdated.__inv}`);
    logger.info(`  __top: ${stats.customFieldsUpdated.__top}`);
    logger.info(`  __badge: ${stats.customFieldsUpdated.__badge}`);
    logger.info('');
    logger.info('Custom Fields Eliminados:');
    logger.info(`  __inv: ${stats.customFieldsDeleted.__inv}`);
    logger.info(`  __top: ${stats.customFieldsDeleted.__top}`);
    logger.info(`  __badge: ${stats.customFieldsDeleted.__badge}`);
    logger.info('');
    logger.info(`Errores: ${stats.errors}`);
    logger.info(`Duración total: ${duration.toFixed(2)} segundos`);
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
