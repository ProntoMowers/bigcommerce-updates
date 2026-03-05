'use strict';

/**
 * Script: checkOrdersInIdeal.js
 *
 * USO:
 *    node src/checkOrdersInIdeal.js all
 *    node src/checkOrdersInIdeal.js 1
 *
 * Ahora:
 *    ✔ Pide FECHA DESDE de forma interactiva (MM/DD/YYYY)
 *    ✔ No reporta órdenes del día actual
 *    ✔ Filtra estados inválidos
 *    ✔ Maneja sufijos "-RN" en IDEAL
 *    ✔ Un solo CSV si STORE_CODE = all
 *    ✔ CSV por tienda si el STORE_CODE es numérico
 *    ✔ Logs solo cuando hay órdenes faltantes
 *    ✔ Añade store_id y store_name en CSV
 *    ✔ Elimina order_number del CSV
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const mysql = require('mysql2/promise');
const axios = require('axios');
const firebird = require('node-firebird');

const SCRIPT_NAME = 'checkOrdersInIdeal';
const LOGS_DIR = path.join(__dirname, '..', 'logs');

// --- LOGGER ---
let logger;
try {
  const createLogger = require('../helpers/logger');
  logger = createLogger(SCRIPT_NAME);
} catch {
  logger = {
    info: console.log,
    warn: console.warn,
    error: console.error,
  };
}

// --- MYSQL POOL ---
const mysqlPool = mysql.createPool({
  host: process.env.MYSQL_HOST,
  port: process.env.MYSQL_PORT,
  user: process.env.MYSQL_USER,
  password: process.env.MYSQL_PASSWORD,
  database: process.env.MYSQL_DATABASE,
  waitForConnections: true,
});

// --- FIREBIRD CONFIG ---
const firebirdOptions = {
  host: process.env.FB_HOST,
  port: Number(process.env.FB_PORT) || 3050,
  database: process.env.FB_DATABASE,
  user: process.env.FB_USER || 'ENDUSER',
  password: process.env.FB_PASSWORD || 'password',
  lowercase_keys: false,
  pageSize: 4096,
};

function getFirebirdConnection() {
  return new Promise((resolve, reject) => {
    firebird.attach(firebirdOptions, (err, db) => {
      if (err) return reject(err);
      resolve(db);
    });
  });
}

function queryFirebird(db, query, params = []) {
  return new Promise((resolve, reject) => {
    db.query(query, params, (err, result) => {
      if (err) return reject(err);
      resolve(result || []);
    });
  });
}

// --- HELPERS ---
function ensureLogsDir() {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
}

// Pedir fecha desde interactiva
async function askDateFromUser() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask() {
    return new Promise((resolve) => {
      rl.question('Ingrese la fecha desde (MM/DD/YYYY): ', resolve);
    });
  }

  let dateInput = '';

  while (true) {
    dateInput = await ask();
    if (/^(0[1-9]|1[0-2])\/(0[1-9]|[12]\d|3[01])\/\d{4}$/.test(dateInput)) break;
    console.log('❌ Formato inválido. Intente de nuevo (MM/DD/YYYY)');
  }

  rl.close();

  const [mm, dd, yyyy] = dateInput.split('/');
  return `${yyyy}-${mm}-${dd}`; // convertir a YYYY-MM-DD
}

// Obtener stores
async function getAllStoreIds() {
  const [rows] = await mysqlPool.execute(`SELECT id FROM stores`);
  return rows.map((r) => r.id);
}

async function getStoreCredentials(storeId) {
  const sql = `SELECT STOREHASH, ACCESSTOKEN, name FROM stores WHERE id = ?`;
  const [rows] = await mysqlPool.execute(sql, [storeId]);

  if (!rows || rows.length === 0) throw new Error(`Store ${storeId} no encontrada`);

  return {
    storeHash: rows[0].STOREHASH,
    accessToken: rows[0].ACCESSTOKEN,
    storeName: rows[0].name,
  };
}

// API BigCommerce
async function fetchOrdersSince(storeHash, accessToken, fromDate) {
  const axiosInstance = axios.create({
    baseURL: `https://api.bigcommerce.com/stores/${storeHash}`,
    headers: {
      'X-Auth-Token': accessToken,
      'X-Auth-Client': process.env.BC_CLIENT_ID,
      'Content-Type': 'application/json',
    },
    timeout: 60000,
  });

  const limit = 250;
  let page = 1;
  const orders = [];

  logger.info(`  ➜ Obteniendo pedidos desde ${fromDate}`);

  while (true) {
    const params = {
      min_date_created: fromDate,
      limit,
      page,
      sort: 'date_created',
      direction: 'asc',
    };

    const { data } = await axiosInstance.get('/v2/orders', { params });

    if (!Array.isArray(data) || data.length === 0) break;

    orders.push(...data);
    if (data.length < limit) break;

    page++;
  }

  return orders;
}

const INVALID_STATUSES = [
  'Cancelled',
  'Incomplete',
  'Pending',
  'Manual Verification Required',
  'Awaiting Payment',
];

function filterValidOrders(orders, today) {
  return orders.filter((o) => {
    const dateCreated = o.date_created.slice(0, 10); // YYYY-MM-DD

    return (
      o.total_inc_tax > 0 &&
      !INVALID_STATUSES.includes(o.status) &&
      dateCreated !== today
    );
  });
}

// Buscar en IDEAL con soporte para sufijo "-RN"
async function findExistingReferencesInIdeal(orderRefs) {
  const db = await getFirebirdConnection();
  const found = new Set();

  const sql = `
    SELECT REFERENCE FROM SALESORDER WHERE REFERENCE LIKE ?
    UNION
    SELECT REFERENCE FROM SALESINVOICE WHERE REFERENCE LIKE ?
    UNION
    SELECT REFERENCE FROM SALESORDERCANCEL WHERE REFERENCE LIKE ?
  `;

  try {
    for (let i = 0; i < orderRefs.length; i++) {
      const baseRef = orderRefs[i].trim();     // E-200046935

      const likeRef = `${baseRef}%`;           // E-200046935%

      const rows = await queryFirebird(db, sql, [likeRef, likeRef, likeRef]);

      if (rows.length > 0) {
        found.add(baseRef); // marcar como encontrada
      }
    }
  } finally {
    db.detach();
  }

  return found;
}

// CSV constructor
function createCsvFile(filename, rows) {
  ensureLogsDir();

  const header = [
    'store_id',
    'store_name',
    'order_id',
    'date_created',
    'status',
    'total_inc_tax',
  ];

  const lines = [header.join(',')];

  rows.forEach((o) => {
    const row = [
      o.store_id,
      o.store_name,
      o.order_id,
      o.date_created,
      o.status,
      o.total_inc_tax,
    ];

    const csvLine = row
      .map((v) => {
        if (v === null || v === undefined) return '';
        const s = String(v);
        return s.includes(',') ? `"${s.replace(/"/g, '""')}"` : s;
      })
      .join(',');

    lines.push(csvLine);
  });

  fs.writeFileSync(filename, lines.join('\n'), 'utf8');
  logger.info(`  📄 CSV generado: ${filename}`);
}

// Procesar una tienda
async function processStore(storeId, fromDate, today) {
  const missing = [];

  try {
    const { storeHash, accessToken, storeName } = await getStoreCredentials(storeId);

    const orders = await fetchOrdersSince(storeHash, accessToken, fromDate);

    const validOrders = filterValidOrders(orders, today);

    const orderRefs = validOrders.map((o) => `E-${o.id}`);

    const foundRefs = await findExistingReferencesInIdeal(orderRefs);

    validOrders.forEach((o) => {
      const ref = `E-${o.id}`;
      if (!foundRefs.has(ref)) {
        missing.push({
          store_id: storeId,
          store_name: storeName,
          order_id: o.id,
          date_created: o.date_created,
          status: o.status,
          total_inc_tax: o.total_inc_tax,
        });
      }
    });

    return missing;
  } catch (e) {
    logger.error(`❌ Error en store ${storeId}: ${e.message}`);
    return missing;
  }
}

// MAIN
async function main() {
  const startTime = Date.now();

  const storeCode = process.argv[2];
  if (!storeCode) {
    console.log(
      `Uso:
  node src/${SCRIPT_NAME}.js all
  node src/${SCRIPT_NAME}.js 3
`
    );
    process.exit(1);
  }

  console.log('\n=== CHECK ORDERS IN IDEAL ===');

  const fromDate = await askDateFromUser();
  const today = new Date().toISOString().slice(0, 10);

  let storeIds = [];

  if (storeCode.toLowerCase() === 'all') {
    storeIds = await getAllStoreIds();
  } else {
    const n = Number(storeCode);
    if (Number.isNaN(n)) {
      throw new Error('STORE_CODE inválido. Debe ser "all" o un número.');
    }
    storeIds = [n];
  }

  const allMissing = [];

  for (const storeId of storeIds) {
    const missing = await processStore(storeId, fromDate, today);

    if (missing.length > 0) {
      logger.info(`❗ Store ${storeId} tiene ${missing.length} órdenes faltantes`);
      allMissing.push(...missing);
    } else {
      logger.info(`✔ Store ${storeId} sin órdenes faltantes`);
    }
  }

  if (allMissing.length === 0) {
    logger.info('✔ No hay órdenes faltantes en ninguna tienda');
  } else {
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(
      2,
      '0'
    )}${String(now.getDate()).padStart(2, '0')}_${String(
      now.getHours()
    ).padStart(2, '0')}${String(now.getMinutes()).padStart(
      2,
      '0'
    )}${String(now.getSeconds()).padStart(2, '0')}`;

    let filename = '';

    if (storeCode.toLowerCase() === 'all') {
      filename = path.join(LOGS_DIR, `missing_orders_ALL_${stamp}.csv`);
    } else {
      filename = path.join(
        LOGS_DIR,
        `missing_orders_store_${storeIds[0]}_${stamp}.csv`
      );
    }

    createCsvFile(filename, allMissing);
  }

  const duration = ((Date.now() - startTime) / 1000).toFixed(2);
  logger.info(`Fin del script. Duración: ${duration} segundos.\n`);
}

main().catch((err) => {
  console.error('Error fatal:', err);
});
