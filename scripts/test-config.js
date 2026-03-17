#!/usr/bin/env node
'use strict';

/**
 * Script de prueba para validar configuración
 * 
 * Uso: node scripts/test-config.js
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
const mysql = require('mysql2/promise');

const REQUIRED_ENV_VARS = [
  'MONGO_URI',
  'MONGO_DB',
  'MYSQL_HOST',
  'MYSQL_USER',
  'MYSQL_PASSWORD',
  'MYSQL_DATABASE',
  'PARTS_API_URL',
  'PARTS_API_KEY',
];

let allPassed = true;

function logSuccess(msg) {
  console.log(`✓ ${msg}`);
}

function logError(msg) {
  console.error(`✗ ${msg}`);
  allPassed = false;
}

function logInfo(msg) {
  console.log(`ℹ ${msg}`);
}

// ============================================
// TEST: Variables de entorno
// ============================================
async function testEnvVars() {
  console.log('\n=== TEST: Variables de Entorno ===');
  
  for (const varName of REQUIRED_ENV_VARS) {
    if (process.env[varName]) {
      logSuccess(`${varName} está configurada`);
    } else {
      logError(`${varName} NO está configurada`);
    }
  }
}

// ============================================
// TEST: MongoDB
// ============================================
async function testMongoDB() {
  console.log('\n=== TEST: MongoDB ===');
  
  try {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(process.env.MONGO_URI);
    
    await client.connect();
    logSuccess('Conexión a MongoDB establecida');
    
    const db = client.db(process.env.MONGO_DB);
    const collections = await db.listCollections().toArray();
    const collectionNames = collections.map(c => c.name);
    
    logInfo(`Base de datos: ${process.env.MONGO_DB}`);
    logInfo(`Colecciones: ${collectionNames.join(', ')}`);
    
    const productsCollection = process.env.MONGO_PRODUCTS_COLLECTION || 'Products';
    if (collectionNames.includes(productsCollection)) {
      logSuccess(`Colección "${productsCollection}" existe`);
      
      const count = await db.collection(productsCollection).countDocuments();
      logInfo(`Total de productos: ${count}`);
      
      if (count > 0) {
        const sample = await db.collection(productsCollection).findOne();
        logInfo(`Ejemplo: ${JSON.stringify(sample, null, 2)}`);
      } else {
        logError('No hay productos en la colección');
      }
    } else {
      logError(`Colección "${productsCollection}" NO existe`);
    }
    
    await client.close();
  } catch (error) {
    logError(`MongoDB: ${error.message}`);
  }
}

// ============================================
// TEST: MySQL
// ============================================
async function testMySQL() {
  console.log('\n=== TEST: MySQL ===');
  
  try {
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: process.env.MYSQL_PORT || 3306,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    });
    
    await pool.execute('SELECT 1');
    logSuccess('Conexión a MySQL establecida');
    
    // Test tabla stores
    const [stores] = await pool.execute('SELECT COUNT(*) as count FROM stores');
    logInfo(`Tiendas en tabla "stores": ${stores[0].count}`);
    
    if (stores[0].count > 0) {
      logSuccess('Tabla "stores" tiene datos');
      const [sample] = await pool.execute('SELECT id, name, STOREHASH FROM stores LIMIT 1');
      logInfo(`Ejemplo: ${JSON.stringify(sample[0])}`);
    } else {
      logError('Tabla "stores" está vacía');
    }
    
    // Test tabla products_abc
    try {
      const [abc] = await pool.execute('SELECT COUNT(*) as count FROM products_abc');
      logInfo(`Registros en "products_abc": ${abc[0].count}`);
      if (abc[0].count > 0) {
        logSuccess('Tabla "products_abc" tiene datos');
      } else {
        logError('Tabla "products_abc" está vacía');
      }
    } catch (err) {
      logError(`Tabla "products_abc" no existe o no es accesible: ${err.message}`);
    }
    
    // Test tabla special_products
    try {
      const [special] = await pool.execute('SELECT COUNT(*) as count FROM special_products');
      logInfo(`Registros en "special_products": ${special[0].count}`);
      logSuccess('Tabla "special_products" existe');
    } catch (err) {
      logError(`Tabla "special_products" no existe o no es accesible: ${err.message}`);
    }
    
    await pool.end();
  } catch (error) {
    logError(`MySQL: ${error.message}`);
  }
}

// ============================================
// TEST: Parts Availability API
// ============================================
async function testPartsAPI() {
  console.log('\n=== TEST: Parts Availability API ===');
  
  try {
    const axios = require('axios');
    
    // Test simple - solo verificar conectividad
    const payload = {
      storeId: 1,
      locationId: 4,
      products: [
        {
          brand: 'TEST',
          sku: 'TEST-123'
        }
      ]
    };
    
    logInfo(`Endpoint: ${process.env.PARTS_API_URL}`);
    
    const response = await axios.post(process.env.PARTS_API_URL, payload, {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.PARTS_API_KEY,
      },
      timeout: 10000,
    });
    
    if (response.status === 200) {
      logSuccess('Parts Availability API responde correctamente');
      logInfo(`Respuesta: ${JSON.stringify(response.data).substring(0, 200)}...`);
    } else {
      logError(`Parts API respondió con status ${response.status}`);
    }
  } catch (error) {
    if (error.response?.status === 401 || error.response?.status === 403) {
      logError('Parts API: Error de autenticación (verificar PARTS_API_KEY)');
    } else if (error.code === 'ECONNREFUSED') {
      logError('Parts API: No se puede conectar al servidor');
    } else {
      logError(`Parts API: ${error.message}`);
    }
  }
}

// ============================================
// TEST: Dependencies
// ============================================
async function testDependencies() {
  console.log('\n=== TEST: Dependencias de Node.js ===');
  
  const dependencies = [
    'dotenv',
    'axios',
    'mongodb',
    'mysql2',
  ];
  
  for (const dep of dependencies) {
    try {
      require(dep);
      logSuccess(`${dep} instalado`);
    } catch (error) {
      logError(`${dep} NO instalado - ejecutar: npm install ${dep}`);
    }
  }
}

// ============================================
// MAIN
// ============================================
async function main() {
  console.log('=================================================');
  console.log('TEST DE CONFIGURACIÓN');
  console.log('updateCustomFieldsInventoryTop.js');
  console.log('=================================================');
  
  await testDependencies();
  await testEnvVars();
  await testMongoDB();
  await testMySQL();
  await testPartsAPI();
  
  console.log('\n=================================================');
  if (allPassed) {
    console.log('✓ TODOS LOS TESTS PASARON');
    console.log('El script está listo para usar.');
  } else {
    console.log('✗ ALGUNOS TESTS FALLARON');
    console.log('Por favor corregir los errores antes de ejecutar el script.');
  }
  console.log('=================================================\n');
  
  process.exit(allPassed ? 0 : 1);
}

main();
