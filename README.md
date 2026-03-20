"# bigcommerce-updates

Scripts de actualización y sincronización para BigCommerce.

## Scripts Disponibles

### 1. Check Orders in IDEAL
Verifica órdenes de BigCommerce contra el sistema IDEAL.

```bash
node src/checkOrdersInIdeal.js STORE_CODE
```

### 2. Update Also Bought (BigQuery)
Actualiza datos de "También compraron" en BigQuery.

```bash
node src/updateAlsoBoughtBQ.js
```

### 3. Update Image Custom Field
Actualiza el custom field de imágenes en productos.

```bash
node src/updateImgCustomField.js STORE_CODE
```

### 4. Update Custom Fields (Inventory, Top, Badge)
**NUEVO:** Sincroniza automáticamente los custom fields `__inv`, `__top` y `__badge`.

```bash
node src/updateCustomFieldsInventoryTop.js STORE_CODE [PRODUCT_ID]
```

**Ejemplos:**
```bash
# Procesar una tienda completa
node src/updateCustomFieldsInventoryTop.js 20

# Procesar un producto específico
node src/updateCustomFieldsInventoryTop.js 20 123

# Procesar todas las tiendas
node src/updateCustomFieldsInventoryTop.js all

# Usando npm script
npm run update-custom-fields -- 20
```

📖 **[Ver documentación completa](docs/updateCustomFieldsInventoryTop.md)**

### 5. Sync Long ETA Preorders
Sincroniza partes de backorder Internet (IDEAL) hacia BigCommerce/MongoDB como `preorder`,
mantiene `long_eta_products` y archiva/revierte productos obsoletos.

```bash
node src/syncLongEtaPreorders.js

# o usando npm
npm run sync-long-eta-preorders
```

### 6. Remove Template Association `product-top-seller`
Busca asociaciones de template custom de Stencil (`product-top-seller`) en BigCommerce,
las elimina vía `Custom Template Associations` y genera un CSV con los productos modificados por tienda.

```bash
node src/removeProductTopSellerLayout.js STORE_CODE

# Procesar una tienda
node src/removeProductTopSellerLayout.js 20

# Procesar todas las tiendas
node src/removeProductTopSellerLayout.js all

# Usando npm script
npm run remove-top-seller-layout -- all
```

## Instalación

```bash
npm install
```

## Configuración

Copiar el archivo de ejemplo y configurar las variables de entorno:

```bash
cp .env.example .env
```

Editar `.env` con las credenciales correctas.

### Variables Requeridas

- **MySQL:** Acceso a base de datos `prontoweb`
- **MongoDB:** Base de datos de productos BigCommerce
- **Firebird:** Conexión a IDEAL (para algunos scripts)
- **Parts Availability API:** URL y API Key
- **PostgreSQL:** (opcional, según el script)
- **BigQuery:** (opcional, para scripts de analytics)

## Estructura del Proyecto

```
bigcommerce-updates/
├── config/
│   └── bigquery.js           # Configuración de BigQuery
├── docs/
│   ├── parts-availability-api.md
│   ├── schema.md
│   └── updateCustomFieldsInventoryTop.md
├── helpers/
│   └── logger.js             # Sistema de logging
├── providers/
│   └── dbConnections.js      # Conexiones a bases de datos
├── src/
│   ├── checkOrdersInIdeal.js
│   ├── updateAlsoBoughtBQ.js
│   ├── updateImgCustomField.js
│   └── updateCustomFieldsInventoryTop.js  ⭐ NUEVO
├── .env.example
└── package.json
```

## Documentación

- [Parts Availability API](docs/parts-availability-api.md)
- [Update Custom Fields - Inventory & Top](docs/updateCustomFieldsInventoryTop.md) ⭐
- [Schema Documentation](docs/schema.md)

## Logs

Los logs se generan en la carpeta `logs/` con formato:

```
logs/scriptName_YYYY-MM-DD.log
```

## Soporte

Para más información sobre cada script, consultar la documentación específica en la carpeta `docs/`.
 
