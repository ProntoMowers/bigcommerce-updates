# Estructura de Datos - updateCustomFieldsInventoryTop.js

Este documento describe la estructura de datos esperada en cada fuente de datos.

## MongoDB

### Base de datos: `bigcommerce`

### Colección: `products`

**Propósito:** Almacenar la relación entre tiendas y productos de BigCommerce.

**Índices recomendados:**
```javascript
db.products.createIndex({ store_id: 1, product_id: 1 })
db.products.createIndex({ store_id: 1 })
db.products.createIndex({ product_id: 1 })
```

**Estructura de documento:**
```json
{
  "_id": ObjectId("507f1f77bcf86cd799439011"),
  "store_id": 20,
  "product_id": 12345,
  "sku": "BRIGGS-123",
  "last_sync": ISODate("2026-03-09T10:00:00Z"),
  "created_at": ISODate("2025-01-01T00:00:00Z")
}
```

**Campos:**
- `_id` (ObjectId): ID único de MongoDB
- `store_id` (Number, **requerido**): ID de la tienda (referencia a `prontoweb.stores.id`)
- `product_id` (Number, **requerido**): ID del producto en BigCommerce
- `sku` (String, opcional): SKU del producto (para referencia)
- `last_sync` (Date, opcional): Última sincronización
- `created_at` (Date, opcional): Fecha de creación del registro

**Query de ejemplo:**
```javascript
// Obtener todos los productos de la tienda 20
db.products.find({ store_id: 20 })

// Obtener un producto específico de una tienda
db.products.findOne({ store_id: 20, product_id: 12345 })

// Contar productos por tienda
db.products.aggregate([
  { $group: { _id: "$store_id", count: { $sum: 1 } } }
])
```

---

## MySQL - Base de datos: `prontoweb`

### Tabla: `stores`

**Propósito:** Almacenar información y credenciales de tiendas BigCommerce.

**Estructura:**
```sql
CREATE TABLE stores (
  id INT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(255),
  STOREHASH VARCHAR(255) NOT NULL,
  ACCESSTOKEN VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

**Datos de ejemplo:**
```sql
INSERT INTO stores (id, name, STOREHASH, ACCESSTOKEN) VALUES
(1, 'Tienda Principal', 'abc123xyz', 'v2_abc123...'),
(20, 'Tienda Sucursal', 'def456uvw', 'v2_def456...');
```

**Campos utilizados por el script:**
- `id` (INT): ID interno de la tienda
- `name` (VARCHAR): Nombre de la tienda (para logs)
- `STOREHASH` (VARCHAR): Hash de la tienda en BigCommerce (ej: `abc123xyz`)
- `ACCESSTOKEN` (VARCHAR): Token de acceso a la API de BigCommerce

---

### Tabla: `products_abc`

**Propósito:** Clasificación ABC de productos basada en datos de IDEAL.

**Estructura:**
```sql
CREATE TABLE products_abc (
  id INT PRIMARY KEY AUTO_INCREMENT,
  mfr VARCHAR(50) NOT NULL,
  partnumber VARCHAR(100) NOT NULL,
  clasif_completo VARCHAR(10),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_mfr_partnumber (mfr, partnumber)
);
```

**Datos de ejemplo:**
```sql
INSERT INTO products_abc (mfr, partnumber, clasif_completo) VALUES
('BRS', '492932S', 'A'),
('KOH', 'KH-24-050-03-S', 'B'),
('ORE', '91-622', 'C'),
('MTD', '954-04050', 'A');
```

**Campos utilizados por el script:**
- `mfr` (VARCHAR): Manufacturer ID de IDEAL (ej: `BRS`, `KOH`, `MTD`)
- `partnumber` (VARCHAR): Part Number de IDEAL (ej: `492932S`)
- `clasif_completo` (VARCHAR): Clasificación del producto
  - `'A'`: Producto Top (alta rotación)
  - `'B'`: Producto Top (media-alta rotación)
  - `'C'`: Producto estándar
  - Otros valores posibles según el sistema de clasificación

**Query del script:**
```sql
SELECT clasif_completo 
FROM products_abc 
WHERE mfr = 'BRS' 
  AND partnumber = '492932S' 
LIMIT 1;
```

**Nota importante:** 
- La comparación se hace con datos de IDEAL (`mfridIdeal`, `partNumberIdeal`)
- NO se compara directamente con el SKU de BigCommerce

---

### Tabla: `special_products`

**Propósito:** Definir productos especiales que siempre deben tener `__inv` y `__top` en "Y".

**Estructura:**
```sql
CREATE TABLE special_products (
  id INT PRIMARY KEY AUTO_INCREMENT,
  brand VARCHAR(255) NOT NULL,
  sku VARCHAR(255) NOT NULL,
  start_date DATE,
  end_date DATE NULL,
  reason VARCHAR(500),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_brand_sku (brand, sku),
  INDEX idx_end_date (end_date)
);
```

**Datos de ejemplo:**
```sql
INSERT INTO special_products (brand, sku, start_date, end_date, reason) VALUES
('BRIGGS & STRATTON', 'BRIGGS 492932S', '2026-01-01', NULL, 'Producto destacado permanente'),
('KOHLER', 'KOHLER KH-24-050-03-S', '2026-03-01', '2026-06-30', 'Promoción Q2 2026'),
('OREGON', 'OREGON 91-622', '2026-02-01', '', 'Producto estratégico');
```

**Campos utilizados por el script:**
- `brand` (VARCHAR): Marca del producto (debe coincidir con `brand_name` de BigCommerce)
- `sku` (VARCHAR): SKU del producto (debe coincidir con `sku` de BigCommerce)
- `end_date` (DATE, NULL): Fecha de finalización
  - `NULL`: Producto especial permanente
  - `''` (vacío): Producto especial permanente
  - Fecha futura: Producto especial hasta esa fecha
  - Fecha pasada: Ya no es producto especial

**Query del script:**
```sql
SELECT 1 
FROM special_products 
WHERE brand = 'BRIGGS & STRATTON' 
  AND sku = 'BRIGGS 492932S'
  AND (end_date IS NULL OR end_date = '' OR end_date > NOW())
LIMIT 1;
```

**Reglas:**
- Si un producto está en esta tabla y está vigente → `__inv = 'Y'` y `__top = 'Y'`
- Esta regla tiene **prioridad absoluta** sobre inventario y clasificación ABC

---

## Parts Availability API

### Endpoint: `POST /v1/parts/availability/resolve`

**Request:**
```json
{
  "storeId": 20,
  "locationId": 4,
  "products": [
    {
      "brand": "BRIGGS & STRATTON",
      "mpn": "492932S"
    },
    {
      "brand": "KOHLER",
      "sku": "KOHLER KH-24-050-03-S"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "storeId": 20,
  "locationId": 4,
  "total": 2,
  "results": [
    {
      "input": {
        "brand": "BRIGGS & STRATTON",
        "sku": null,
        "mpn": "492932S"
      },
      "match": {
        "strategy": "product_match",
        "mfridIdeal": "BRS",
        "partNumberIdeal": "492932S"
      },
      "inventory": {
        "onHandAvailability": 268
      }
    },
    {
      "input": {
        "brand": "KOHLER",
        "sku": "KOHLER KH-24-050-03-S",
        "mpn": null
      },
      "match": {
        "strategy": "sku_match",
        "mfridIdeal": "KOH",
        "partNumberIdeal": "KH-24-050-03-S"
      },
      "inventory": {
        "onHandAvailability": 0
      }
    }
  ]
}
```

**Campos utilizados por el script:**
- `results[].match.mfridIdeal` (String): Manufacturer ID en IDEAL
- `results[].match.partNumberIdeal` (String): Part Number en IDEAL
- `results[].inventory.onHandAvailability` (Number): Cantidad disponible en inventario

**Notas:**
- Siempre usar `locationId: 4`
- Máximo 50 productos por request
- Priorizar `mpn` sobre `sku` en el request

---

## BigCommerce API

### GET /catalog/products

**Request:**
```
GET /stores/{store_hash}/v3/catalog/products?id:in=123,456,789&include=custom_fields&limit=50
```

**Response:**
```json
{
  "data": [
    {
      "id": 123,
      "sku": "BRIGGS 492932S",
      "mpn": "492932S",
      "brand_name": "BRIGGS & STRATTON",
      "is_free_shipping": true,
      "custom_fields": [
        {
          "id": 1,
          "name": "__inv",
          "value": "Y"
        },
        {
          "id": 2,
          "name": "__top",
          "value": "Y"
        },
        {
          "id": 3,
          "name": "__badge",
          "value": "Free Shipping"
        }
      ]
    }
  ]
}
```

**Campos utilizados:**
- `id` (Number): ID del producto en BigCommerce
- `sku` (String): SKU del producto
- `mpn` (String): Manufacturer Part Number (prioridad sobre SKU)
- `brand_name` (String): Nombre de la marca
- `is_free_shipping` (Boolean): Flag de envío gratis
- `custom_fields` (Array): Custom fields actuales
  - `id` (Number): ID del custom field
  - `name` (String): Nombre del custom field
  - `value` (String): Valor del custom field

### Custom Fields esperados

**Custom Field: `__inv`**
```json
{
  "name": "__inv",
  "value": "Y"
}
```

**Custom Field: `__top`**
```json
{
  "name": "__top",
  "value": "Y"
}
```

**Custom Field: `__badge`**
```json
{
  "name": "__badge",
  "value": "Free Shipping"
}
```

---

## Flujo de Datos

```
┌─────────────┐
│   MongoDB   │  →  Lista de product_id por store_id
└─────────────┘
       ↓
┌─────────────┐
│ BigCommerce │  →  Detalles del producto (sku, mpn, brand, is_free_shipping, custom_fields)
└─────────────┘
       ↓
┌─────────────┐
│  Parts API  │  →  mfridIdeal, partNumberIdeal, onHandAvailability
└─────────────┘
       ↓
┌─────────────┐
│MySQL: stores│  →  Credenciales BigCommerce
│products_abc │  →  Clasificación ABC (usando mfridIdeal + partNumberIdeal)
│special_prod │  →  Verificar si es producto especial
└─────────────┘
       ↓
┌─────────────┐
│   LÓGICA    │  →  Calcular valores deseados para __inv, __top, __badge
└─────────────┘
       ↓
┌─────────────┐
│ BigCommerce │  →  Crear/Actualizar/Eliminar custom fields
└─────────────┘
```

---

## Ejemplos de Casos de Uso

### Caso 1: Producto con inventario y clasificación A

**Datos:**
- `onHandAvailability`: 100
- `clasif_completo`: 'A'
- `is_free_shipping`: true
- No es producto especial

**Resultado:**
- `__inv = 'Y'` ✓
- `__top = 'Y'` ✓
- `__badge = 'Free Shipping'` ✓

### Caso 2: Producto sin inventario, clasificación C, sin free shipping

**Datos:**
- `onHandAvailability`: 0
- `clasif_completo`: 'C'
- `is_free_shipping`: false
- No es producto especial

**Resultado:**
- `__inv` eliminado ✗
- `__top` eliminado ✗
- `__badge` eliminado ✗

### Caso 3: Producto especial (ignora todo lo demás)

**Datos:**
- `onHandAvailability`: 0
- `clasif_completo`: 'C'
- `is_free_shipping`: false
- **ES producto especial**

**Resultado:**
- `__inv = 'Y'` ✓ (forzado por special_products)
- `__top = 'Y'` ✓ (forzado por special_products)
- `__badge` eliminado ✗

### Caso 4: Producto con inventario, clasificación B, con free shipping

**Datos:**
- `onHandAvailability`: 50
- `clasif_completo`: 'B'
- `is_free_shipping`: true
- No es producto especial

**Resultado:**
- `__inv = 'Y'` ✓
- `__top = 'Y'` ✓ (clasificación B también es Top)
- `__badge = 'Free Shipping'` ✓
