# Sincronización de Custom Fields en BigCommerce

Este script (`updateCustomFieldsInventoryTop.js`) sincroniza automáticamente los custom fields `__inv`, `__top` y `__badge` en productos de BigCommerce basándose en:

- Inventario disponible en IDEAL
- Clasificación ABC de productos
- Productos especiales
- Flag de Free Shipping

## Instalación

Primero, instalar las dependencias necesarias:

```bash
npm install
```

Si es necesario instalar solo MongoDB:

```bash
npm install mongodb
```

## Variables de Entorno Requeridas

Agregar al archivo `.env`:

```bash
# MongoDB - Base de datos de productos
MONGO_URL=mongodb://localhost:27017
MONGO_DB_NAME=bigcommerce

# MySQL - Base de datos prontoweb
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=usuario
MYSQL_PASSWORD=password
MYSQL_DATABASE=prontoweb

# Parts Availability API
PARTS_API_URL=http://10.1.10.21:3001/v1/parts/availability/resolve
PARTS_API_KEY=your_api_key_here
```

## Uso del Script

### Sintaxis

```bash
node src/updateCustomFieldsInventoryTop.js STORE_CODE [PRODUCT_ID]
```

### Parámetros

| Parámetro | Requerido | Descripción |
|-----------|-----------|-------------|
| `STORE_CODE` | Sí | Código de la tienda (número) o `all` para todas las tiendas |
| `PRODUCT_ID` | No | ID específico de producto (para pruebas o actualizaciones individuales) |

### Ejemplos

#### Procesar una tienda completa

```bash
node src/updateCustomFieldsInventoryTop.js 20
```

Procesa todos los productos de la tienda con ID 20.

#### Procesar un solo producto de una tienda

```bash
node src/updateCustomFieldsInventoryTop.js 20 123
```

Procesa solo el producto con ID 123 de la tienda 20.

#### Procesar todas las tiendas

```bash
node src/updateCustomFieldsInventoryTop.js all
```

Procesa todos los productos de todas las tiendas registradas.

#### Procesar un producto específico en todas las tiendas

```bash
node src/updateCustomFieldsInventoryTop.js all 123
```

Busca y procesa el producto 123 en todas las tiendas (útil para pruebas).

#### Usando npm script

```bash
npm run update-custom-fields -- 20
npm run update-custom-fields -- 20 123
npm run update-custom-fields -- all
```

## Reglas de Negocio

### Custom Field: `__inv`

**Propósito:** Indica si el producto tiene inventario disponible.

**Valor:** `"Y"` (cuando aplica)

**Regla:**
- Se establece en `"Y"` si `onHandAvailability > 0`
- Se elimina si `onHandAvailability <= 0`
- **Excepción:** Productos en `special_products` siempre tienen `__inv = "Y"`

### Custom Field: `__top`

**Propósito:** Indica productos Top (clasificación A o B).

**Valor:** `"Y"` (cuando aplica)

**Regla:**
- Se consulta en `products_abc` usando `mfridIdeal` y `partNumberIdeal` (obtenidos de la API de Parts Availability)
- Se establece en `"Y"` si `clasif_completo` es `'A'` o `'B'`
- Se elimina si la clasificación es otra o no existe
- **Excepción:** Productos en `special_products` siempre tienen `__top = "Y"`

### Custom Field: `__badge`

**Propósito:** Indica que el producto tiene envío gratis (Free Shipping).

**Valor:** `"Free Shipping"`

**Regla:**
- Se establece en `"Free Shipping"` si `is_free_shipping = true` en BigCommerce
- Se elimina si `is_free_shipping = false`

### Productos Especiales - Prioridad Máxima

Los productos en la tabla `special_products` que cumplan:

```sql
end_date IS NULL OR end_date = '' OR end_date > NOW()
```

Son considerados productos especiales y **siempre** tienen:
- `__inv = "Y"`
- `__top = "Y"`

Esta regla tiene **prioridad sobre todas las demás**.

## Fuentes de Datos

### 1. MongoDB

**Propósito:** Obtener la lista de IDs de productos por tienda.

**Colección:** `products`

**Campos utilizados:**
- `store_id`: ID de la tienda
- `product_id`: ID del producto en BigCommerce

### 2. MySQL - Base de datos `prontoweb`

#### Tabla: `stores`

Credenciales y configuración de tiendas BigCommerce.

**Campos relevantes:**
- `id`: ID interno de la tienda
- `STOREHASH`: Hash de la tienda en BigCommerce
- `ACCESSTOKEN`: Token de acceso a la API
- `name`: Nombre de la tienda

#### Tabla: `products_abc`

Clasificación ABC de productos.

**Campos relevantes:**
- `mfr`: Manufacturer ID (de IDEAL)
- `partnumber`: Número de parte (de IDEAL)
- `clasif_completo`: Clasificación (`'A'`, `'B'`, `'C'`, etc.)

#### Tabla: `special_products`

Productos especiales que deben tener `__inv` y `__top` forzados.

**Campos relevantes:**
- `brand`: Marca del producto
- `sku`: SKU del producto
- `end_date`: Fecha de fin (puede ser NULL o vacío para productos permanentes)

### 3. Parts Availability API

**Endpoint:** `POST /v1/parts/availability/resolve`

**Propósito:** 
- Resolver equivalencias con IDEAL
- Obtener inventario disponible

**Parámetros:**
- `storeId`: ID interno de la tienda
- `locationId`: Siempre usar `4`
- `products`: Array de productos (máximo 50 por request)

**Respuesta utilizada:**
- `match.mfridIdeal`: Manufacturer ID en IDEAL
- `match.partNumberIdeal`: Part Number en IDEAL
- `inventory.onHandAvailability`: Cantidad disponible en inventario

### 4. BigCommerce API

**Propósito:** 
- Obtener detalles de productos
- Administrar custom fields

**Endpoints utilizados:**
- `GET /catalog/products?id:in={ids}&include=custom_fields`
- `GET /catalog/products/{productId}`
- `GET /catalog/products/{productId}/custom-fields`
- `POST /catalog/products/{productId}/custom-fields`
- `PUT /catalog/products/{productId}/custom-fields/{fieldId}`
- `DELETE /catalog/products/{productId}/custom-fields/{fieldId}`

**Campos del producto utilizados:**
- `id`: ID del producto
- `sku`: SKU del producto
- `mpn`: Manufacturer Part Number
- `brand_name`: Nombre de la marca
- `is_free_shipping`: Flag de envío gratis
- `custom_fields`: Custom fields actuales

## Flujo de Procesamiento

1. **Validación de argumentos** - Verificar STORE_CODE y PRODUCT_ID opcional
2. **Conexión a bases de datos** - MongoDB y MySQL
3. **Resolver tiendas** - Una específica o todas
4. **Por cada tienda:**
   - Obtener credenciales de BigCommerce
   - Obtener IDs de productos desde MongoDB
   - Obtener detalles de productos desde BigCommerce
   - Procesar en lotes de 50 productos:
     - Consultar Parts Availability API
     - Consultar tabla `products_abc` (con datos de IDEAL)
     - Verificar si son productos especiales
     - Calcular valores deseados para custom fields
     - Sincronizar custom fields en BigCommerce
5. **Resumen final** - Estadísticas del proceso

## Procesamiento por Lotes

La API de Parts Availability soporta hasta **50 productos por request**.

El script automáticamente:
- Agrupa productos en lotes de 50
- Procesa cada lote secuencialmente
- Registra el progreso en los logs

## Logs

El script genera logs detallados en: `logs/updateCustomFieldsInventoryTop_YYYY-MM-DD.log`

### Información registrada:

- **Inicio:** Fecha, hora, parámetros recibidos
- **Por tienda:** 
  - Nombre y hash de la tienda
  - Cantidad de productos a procesar
  - Progreso por lotes
- **Por producto:**
  - Productos especiales identificados
  - Clasificación ABC obtenida
  - Custom fields creados/actualizados/eliminados
- **Errores:** 
  - Errores de API
  - Errores de base de datos
  - Errores por producto
- **Resumen final:**
  - Tiendas procesadas
  - Productos analizados
  - Productos con inventario
  - Productos A/B
  - Productos especiales
  - Cambios realizados por tipo de custom field
  - Duración total

## Sincronización de Custom Fields

Para cada custom field (`__inv`, `__top`, `__badge`):

| Estado Actual | Valor Deseado | Acción |
|---------------|---------------|--------|
| No existe | Valor X | **CREAR** con valor X |
| Existe con valor Y | Valor X | **ACTUALIZAR** a valor X |
| Existe con valor X | Valor X | **No hacer nada** |
| Existe | null/undefined | **ELIMINAR** |
| No existe | null/undefined | **No hacer nada** |

## Criterios de Aceptación

- ✅ Acepta `STORE_CODE` como número o `all`
- ✅ Acepta `PRODUCT_ID` opcional para procesamiento individual
- ✅ Obtiene productos desde MongoDB (no directamente de BigCommerce)
- ✅ Usa siempre `locationId = 4` en la API de Parts Availability
- ✅ Consulta `products_abc` usando datos de IDEAL (`mfr` + `partnumber`)
- ✅ Aplica reglas de productos especiales con prioridad máxima
- ✅ Actualiza correctamente `__inv` según inventario
- ✅ Actualiza correctamente `__top` según clasificación ABC
- ✅ Actualiza correctamente `__badge` según Free Shipping
- ✅ No actualiza custom fields si ya tienen el valor correcto
- ✅ Registra logs completos del proceso
- ✅ Procesa productos en lotes de 50
- ✅ Maneja errores sin detener el proceso completo

## Solución de Problemas

### Error: No se puede conectar a MongoDB

Verificar:
- Variables `MONGO_URL` y `MONGO_DB_NAME` en `.env`
- Que MongoDB esté corriendo
- Permisos de conexión

### Error: Tienda no encontrada

Verificar:
- Que el `STORE_CODE` exista en la tabla `stores`
- Que tenga `STOREHASH` y `ACCESSTOKEN` configurados

### Error: No hay productos en MongoDB

Verificar:
- Que existan registros en la colección `products` con el `store_id` correspondiente
- Estructura correcta: `{ store_id: Number, product_id: Number }`

### Error de Parts Availability API

Verificar:
- `PARTS_API_URL` configurada correctamente
- `PARTS_API_KEY` válida
- Conectividad con el servidor de la API

### Error de BigCommerce API (401, 403)

Verificar:
- `ACCESSTOKEN` válido en la tabla `stores`
- Permisos del token para leer/escribir custom fields

## Mantenimiento

### Agregar nueva lógica para custom fields

1. Editar función `calculateCustomFieldValues()`
2. Agregar nuevo campo al objeto `values`
3. Agregar el nombre del campo al array `fieldsToSync` en `syncCustomFields()`
4. Actualizar estadísticas en el objeto `stats` global

### Modificar tamaño de lotes

Cambiar la constante:

```javascript
const BATCH_SIZE = 50; // Máximo recomendado por la API
```

## Notas Importantes

- **Location ID:** Siempre se usa `locationId = 4` según especificación
- **Prioridad MPN:** Si un producto tiene `mpn`, se usa para consultar la API; si no, se usa `sku`
- **Comparación con IDEAL:** La clasificación ABC se compara con datos de IDEAL (no con SKU de BigCommerce)
- **Productos especiales:** Tienen prioridad absoluta sobre cualquier otra regla
- **Valores exactos:** Los valores deben ser exactamente `"Y"` y `"Free Shipping"` (case-sensitive)
