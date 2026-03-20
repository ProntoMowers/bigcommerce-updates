'use strict';

/**
 * Script: debugProductLayoutFile.js
 *
 * Devuelve información de templates para un producto específico en una tienda,
 * priorizando Custom Template Associations (Stencil).
 *
 * Uso:
 *   node src/debugProductLayoutFile.js STORE_ID PRODUCT_ID [CHANNEL_ID]
 *
 * Ejemplo:
 *   node src/debugProductLayoutFile.js 3 20029 1
 */

require('dotenv').config();
const axios = require('axios');
const { getMySqlConnection } = require('../providers/dbConnections');

function normalizeLayout(layoutFile) {
  let value = String(layoutFile || '').trim().toLowerCase();
  if (!value) return '';

  value = value.replace(/\\/g, '/');
  const parts = value.split('/').filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : value;
  return last.endsWith('.html') ? last.slice(0, -5) : last;
}

async function getStoreCredentials(storeId) {
  const pool = getMySqlConnection();
  const [rows] = await pool.execute(
    `SELECT id, name, STOREHASH, ACCESSTOKEN
     FROM stores
     WHERE id = ?
     LIMIT 1`,
    [storeId]
  );

  if (!rows.length) {
    throw new Error(`No existe la tienda con id=${storeId}`);
  }

  const store = rows[0];
  if (!store.STOREHASH || !store.ACCESSTOKEN) {
    throw new Error(`La tienda ${storeId} no tiene STOREHASH/ACCESSTOKEN`);
  }

  return store;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] === '--help' || args[0] === '-h') {
    console.log('Uso: node src/debugProductLayoutFile.js STORE_ID PRODUCT_ID [CHANNEL_ID]');
    console.log('Ejemplo: node src/debugProductLayoutFile.js 3 20029 1');
    process.exit(args.length < 2 ? 1 : 0);
  }

  const storeId = parseInt(args[0], 10);
  const productId = parseInt(args[1], 10);
  const channelId = args[2] !== undefined ? parseInt(args[2], 10) : null;

  if (Number.isNaN(storeId) || Number.isNaN(productId) || (args[2] !== undefined && Number.isNaN(channelId))) {
    console.error('STORE_ID, PRODUCT_ID y CHANNEL_ID (si se envía) deben ser numéricos.');
    process.exit(1);
  }

  try {
    const store = await getStoreCredentials(storeId);
    const baseUrlV3 = `https://api.bigcommerce.com/stores/${store.STOREHASH}/v3`;
    const baseUrlV2 = `https://api.bigcommerce.com/stores/${store.STOREHASH}`;

    const headers = {
      'X-Auth-Token': store.ACCESSTOKEN,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    };

    const clientV3 = axios.create({ baseURL: baseUrlV3, headers, timeout: 30000 });
    const clientV2 = axios.create({ baseURL: baseUrlV2, headers, timeout: 30000 });

    const associationParams = {
      type: 'product',
      'entity_id:in': productId,
      ...(channelId !== null ? { channel_id: channelId } : {}),
      limit: 250,
      page: 1,
    };

    const [v3Single, customAssociations, v3List, v2Product] = await Promise.allSettled([
      clientV3.get(`/catalog/products/${productId}`),
      clientV3.get('/storefront/custom-template-associations', {
        params: associationParams,
      }),
      clientV3.get('/catalog/products', {
        params: {
          id: productId,
          limit: 1,
          include_fields: 'id,name,sku,layout_file',
        },
      }),
      clientV2.get(`/v2/products/${productId}.json`),
    ]);

    const payload = {
      input: {
        storeId,
        storeName: store.name,
        storeHash: store.STOREHASH,
        productId,
        channelId,
      },
      custom_template_associations: null,
      v3_single: null,
      v3_list: null,
      v2: null,
      recommendation: null,
    };

    if (customAssociations.status === 'fulfilled') {
      const rows = customAssociations.value.data?.data || [];
      const meta = customAssociations.value.data?.meta || null;
      payload.custom_template_associations = {
        count: rows.length,
        data: rows.map((row) => ({
          id: row.id,
          channel_id: row.channel_id,
          entity_type: row.entity_type,
          entity_id: row.entity_id,
          file_name: row.file_name,
          normalized_file_name: normalizeLayout(row.file_name),
        })),
        meta,
      };
    } else {
      payload.custom_template_associations = {
        error:
          customAssociations.reason?.response?.data ||
          customAssociations.reason?.message ||
          'Error desconocido',
      };
    }

    if (v3Single.status === 'fulfilled') {
      const p = v3Single.value.data?.data || {};
      payload.v3_single = {
        id: p.id,
        name: p.name,
        sku: p.sku,
        layout_file: p.layout_file,
        normalized_layout_file: normalizeLayout(p.layout_file),
      };
    } else {
      payload.v3_single = {
        error: v3Single.reason?.response?.data || v3Single.reason?.message || 'Error desconocido',
      };
    }

    if (v3List.status === 'fulfilled') {
      const p = (v3List.value.data?.data || [])[0] || null;
      payload.v3_list = p
        ? {
            id: p.id,
            name: p.name,
            sku: p.sku,
            layout_file: p.layout_file,
            normalized_layout_file: normalizeLayout(p.layout_file),
          }
        : { warning: 'Producto no regresado por endpoint de listado.' };
    } else {
      payload.v3_list = {
        error: v3List.reason?.response?.data || v3List.reason?.message || 'Error desconocido',
      };
    }

    if (v2Product.status === 'fulfilled') {
      const p = v2Product.value.data || {};
      payload.v2 = {
        id: p.id,
        name: p.name,
        sku: p.sku,
        layout_file: p.layout_file,
        normalized_layout_file: normalizeLayout(p.layout_file),
      };
    } else {
      payload.v2 = {
        error: v2Product.reason?.response?.data || v2Product.reason?.message || 'Error desconocido',
      };
    }

    const assocData = Array.isArray(payload.custom_template_associations?.data)
      ? payload.custom_template_associations.data
      : [];
    const selectedAssociation = channelId === null
      ? assocData[0] || null
      : assocData.find((item) => item.channel_id === channelId) || null;

    if (selectedAssociation) {
      payload.recommendation = {
        strategy: 'stencil_custom_template_associations',
        selected: selectedAssociation,
        note: 'Para Stencil, usa file_name de Custom Template Associations como fuente primaria.',
      };
    } else {
      payload.recommendation = {
        strategy: 'stencil_custom_template_associations',
        selected: null,
        note:
          'No hay asociación en Custom Template Associations para este producto/canal. Si el producto usa plantilla custom, debe crearse vía PUT /v3/storefront/custom-template-associations.',
      };
    }

    console.log(JSON.stringify(payload, null, 2));
  } catch (error) {
    const status = error.response?.status;
    const data = error.response?.data;
    console.error('Error:', error.message);
    if (status) console.error('HTTP status:', status);
    if (data) console.error('HTTP data:', JSON.stringify(data));
    process.exit(1);
  }
}

main();
