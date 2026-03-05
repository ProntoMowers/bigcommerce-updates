// File: src/updateImgCustomField.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const axios = require('axios');

// ===== Logger fallback =====
let logger;
try { logger = require('../helpers/logger'); }
catch {
  logger = {
    createLogger: (name) => {
      const logfile = path.join('logs', `${name}_${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
      if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });
      const write = (lvl, msg, meta) => {
        const line = `[${new Date().toISOString()}] [${lvl.toUpperCase()}] ${msg}${meta ? ' ' + JSON.stringify(meta) : ''}\n`;
        fs.appendFileSync(logfile, line);
        (lvl === 'error' ? console.error : console.log)(msg, meta || '');
      };
      return {
        info: (m, a) => write('log', m, a),
        warn: (m, a) => write('warn', m, a),
        error: (m, a) => write('error', m, a),
        logfile,
      };
    },
  };
}
const log = logger.createLogger('updateImgCustomField');

// ===== MySQL (usa variables MYSQL_*) =====
let mysqlPool;
async function initMySQL() {
  if (mysqlPool) return mysqlPool;
  mysqlPool = await mysql.createPool({
    host: process.env.MYSQL_HOST || 'localhost',
    port: process.env.MYSQL_PORT ? Number(process.env.MYSQL_PORT) : 3306,
    user: process.env.MYSQL_USER,
    password: process.env.MYSQL_PASSWORD,
    database: process.env.MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    timezone: 'Z',
    dateStrings: true,
  });
  return mysqlPool;
}

async function getAllStoreIds() {
  const pool = await initMySQL();
  log.info('Obteniendo todos los store IDs desde la base de datos...');
  const [rows] = await pool.execute('SELECT id FROM stores');
  if (!rows?.length) {
    log.warn('No se encontraron stores en la base de datos.');
    return [];
  }
  const ids = rows.map(r => r.id);
  log.info(`Se encontraron ${ids.length} stores para procesar.`);
  return ids;
}

async function getStoreCredentials(storeId) {
  const pool = await initMySQL();
  const [rows] = await pool.execute('SELECT STOREHASH, ACCESSTOKEN FROM stores WHERE id = ?', [storeId]);
  if (!rows?.length) throw new Error(`Store con ID ${storeId} no encontrada`);
  return { storeHash: rows[0].STOREHASH, accessToken: rows[0].ACCESSTOKEN };
}

// ===== Axios BigCommerce =====
function logAxiosError(err, context = {}) {
  const status = err?.response?.status;
  const url = err?.config?.url;
  const method = err?.config?.method;
  const data = err?.response?.data;
  log.error('Axios error', { status, method, url, context, data });
}

function bcClient(storeHash, accessToken) {
  const instance = axios.create({
    baseURL: `https://api.bigcommerce.com/stores/${storeHash}/v3`,
    headers: {
      'X-Auth-Token': accessToken,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    timeout: 30000,
  });

  instance.interceptors.response.use(
    r => r,
    async (error) => {
      const cfg = error.config || {};
      const status = error.response?.status;
      const shouldRetry = [429, 500, 502, 503, 504].includes(status) && (cfg.__retryCount || 0) < 5;
      if (shouldRetry) {
        cfg.__retryCount = (cfg.__retryCount || 0) + 1;
        const waitMs = Math.min(1000 * Math.pow(2, cfg.__retryCount), 15000);
        log.warn(`BC ${status} reintento #${cfg.__retryCount} en ${waitMs}ms`, { url: cfg.url });
        await new Promise(r => setTimeout(r, waitMs));
        return instance(cfg);
      }
      logAxiosError(error);
      throw error;
    }
  );
  return instance;
}

// ===== Helpers BigCommerce =====
async function getProduct(api, productId) {
  const { data } = await api.get(`/catalog/products/${productId}`, {
    params: { include_fields: 'id,sku,name' },
  });
  return data?.data;
}

async function getPrimaryImage(api, productId) {
  const { data } = await api.get(`/catalog/products/${productId}/images`, {
    params: {
      limit: 250,
      include_fields: 'id,is_thumbnail,sort_order,description,url_zoom,url_standard,url_thumbnail,image_url',
    },
  });
  const images = data?.data || [];
  if (!images.length) return null;
  const byOrder = [...images].sort(
    (a, b) => (Number(a.is_thumbnail ? 0 : 1) - Number(b.is_thumbnail ? 0 : 1)) || (a.sort_order ?? 0) - (b.sort_order ?? 0)
  );
  const img = byOrder[0];
  return {
    url: img.url_standard || img.url_zoom || img.url_thumbnail || img.image_url || '',
    description: img.description || '',
  };
}

async function getCustomFields(api, productId) {
  const { data } = await api.get(`/catalog/products/${productId}/custom-fields`, { params: { limit: 250 } });
  return data?.data || [];
}

async function createCustomField(api, productId, name, value) {
  const { data } = await api.post(`/catalog/products/${productId}/custom-fields`, { name, value });
  return data?.data;
}

async function updateCustomField(api, productId, customFieldId, value) {
  const { data } = await api.put(`/catalog/products/${productId}/custom-fields/${customFieldId}`, { value });
  return data?.data;
}

// ===== Reglas de decisión =====
function flagFromUrl(url = '') {
  const m = url.match(/[-_](nwm|dgr)_/i);
  return m ? m[1].toUpperCase() : null;
}
function shouldSetNWMFromImage(primaryImage) {
  if (!primaryImage) return false;
  const text = `${primaryImage.url || ''} ${primaryImage.description || ''}`.replace(/\s+/g, ' ').trim();
  const hasLogo = /(^|[^a-z])logo([^a-z]|$)/i.test(text);
  return !hasLogo;
}

// ===== CSV Writer =====
function initCsvWriter(storeId) {
  if (!fs.existsSync('logs')) fs.mkdirSync('logs', { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  const csvPath = path.join('logs', `__IMG_updates_store${storeId}_${stamp}.csv`);
  fs.writeFileSync(
    csvPath,
    'timestamp,storeId,productId,sku,action,from,to,image_url,image_alt,reason\n',
    'utf8'
  );
  return csvPath;
}
function appendCsv(csvPath, row) {
  const safe = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const line = [
    new Date().toISOString(),
    row.storeId,
    row.productId,
    safe(row.sku),
    row.action,
    safe(row.from),
    safe(row.to),
    safe(row.image_url),
    safe(row.image_alt),
    safe(row.reason),
  ].join(',') + '\n';
  fs.appendFileSync(csvPath, line, 'utf8');
}

// ===== Lógica __IMG =====
async function ensureIMGField(api, storeId, product) {
  const productId = product.id;
  const sku = product.sku || '';
  const primaryImage = await getPrimaryImage(api, productId);
  const urlFlag = flagFromUrl(primaryImage?.url || '');
  const notLogo = shouldSetNWMFromImage(primaryImage);

  const desired = urlFlag || (notLogo ? 'NWM' : null);
  if (!desired) {
    return { storeId, productId, sku, action: 'skip', changed: false, primaryImage, reason: 'image_has_logo_or_no_signal' };
  }

  const fields = await getCustomFields(api, productId);
  const imgField = fields.find(f => f.name === '__IMG');

  if (imgField) {
    const current = (imgField.value || '').trim().toUpperCase();
    if (current === 'NWM' || current === 'DGR') {
      return { storeId, productId, sku, action: 'kept-existing', value: current, changed: false, primaryImage, reason: 'already_final_value' };
    }
    await updateCustomField(api, productId, imgField.id, desired);
    return { storeId, productId, sku, action: 'updated', from: current, to: desired, changed: true, primaryImage, reason: urlFlag ? 'url_flag' : 'no_logo' };
  } else {
    await createCustomField(api, productId, '__IMG', desired);
    return { storeId, productId, sku, action: 'created', to: desired, changed: true, primaryImage, reason: urlFlag ? 'url_flag' : 'no_logo' };
  }
}

// ===== Procesamiento =====
async function processSingleProduct(api, storeId, productId, csvPath) {
  const product = await getProduct(api, productId);
  if (!product) {
    log.warn(`Store ${storeId}: producto ${productId} no encontrado`);
    return { processed: 0, changed: 0 };
  }
  const res = await ensureIMGField(api, storeId, product);
  log.info(`Store ${storeId} - Producto ${product.id} (${product.sku || 'sin SKU'}): ${res.action}`, res);
  if (res.changed) {
    appendCsv(csvPath, {
      storeId, productId: res.productId, sku: res.sku,
      action: res.action, from: res.from || '', to: res.to || '',
      image_url: res.primaryImage?.url || '', image_alt: res.primaryImage?.description || '', reason: res.reason || '',
    });
  }
  return { processed: 1, changed: res.changed ? 1 : 0 };
}

async function processAllProducts(api, storeId, csvPath) {
  let page = 1;
  const limit = 250;
  let processed = 0, changed = 0;

  while (true) {
    const { data } = await api.get('/catalog/products', {
      params: { page, limit, is_visible: 1, include_fields: 'id,sku' },
    });
    const products = data?.data || [];
    if (!products.length) break;

    for (const p of products) {
      const res = await ensureIMGField(api, storeId, p);
      processed++;
      if (res.changed) {
        changed++;
        appendCsv(csvPath, {
          storeId, productId: res.productId, sku: res.sku,
          action: res.action, from: res.from || '', to: res.to || '',
          image_url: res.primaryImage?.url || '', image_alt: res.primaryImage?.description || '', reason: res.reason || '',
        });
      }
      log.info(`Store ${storeId} - Producto ${p.id} (${p.sku || 'sin SKU'}): ${res.action}`, res);
    }
    if (products.length < limit) break;
    page++;
  }
  return { processed, changed };
}

// ===== Main =====
(async () => {
  const [,, storeArg, productArg] = process.argv;
  if (!storeArg) {
    console.error('❌ Uso: node src/updateImgCustomField.js STORE_CODE [PRODUCT_ID]');
    process.exit(1);
  }

  const start = Date.now();
  log.info('▶️ Inicio de proceso updateImgCustomField', { storeArg, productArg });

  const storeIds = storeArg === 'all' ? await getAllStoreIds() : [storeArg];
  for (const storeId of storeIds) {
    log.info(`===== Procesando Tienda ${storeId} =====`);
    const csvPath = initCsvWriter(storeId);
    try {
      const { storeHash, accessToken } = await getStoreCredentials(storeId);
      const api = bcClient(storeHash, accessToken);

      const result = productArg
        ? await processSingleProduct(api, storeId, productArg, csvPath)
        : await processAllProducts(api, storeId, csvPath);

      log.info(`✅ Tienda ${storeId} completada`, { ...result, csvPath: path.resolve(csvPath) });
      console.log(`📑 CSV generado: ${path.resolve(csvPath)}`);
    } catch (e) {
      log.error(`❌ Error en tienda ${storeId}`, { message: e.message, stack: e.stack });
    }
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  log.info(`🏁 Proceso finalizado en ${elapsed}s`);
})();
