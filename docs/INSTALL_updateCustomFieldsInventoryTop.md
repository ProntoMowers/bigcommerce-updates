# Guía de Instalación - updateCustomFieldsInventoryTop.js

## Paso 1: Instalar dependencias

Si es la primera vez que usas el proyecto:

```bash
npm install
```

Si solo necesitas agregar MongoDB:

```bash
npm install mongodb
```

## Paso 2: Configurar variables de entorno

Si no existe el archivo `.env`, créalo copiando el ejemplo:

```bash
copy .env.example .env
```

O en PowerShell:

```powershell
Copy-Item .env.example .env
```

## Paso 3: Editar `.env`

Abre el archivo `.env` y configura las siguientes variables:

### MongoDB (REQUERIDO)
```bash
MONGO_URL=mongodb://localhost:27017
MONGO_DB_NAME=bigcommerce
```

### MySQL (REQUERIDO)
```bash
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=tu_usuario
MYSQL_PASSWORD=tu_password
MYSQL_DATABASE=prontoweb
```

### Parts Availability API (REQUERIDO)
```bash
PARTS_API_URL=http://10.1.10.21:3001/v1/parts/availability/resolve
PARTS_API_KEY=tu_api_key
```

## Paso 4: Verificar conexiones

### Verificar MongoDB

```bash
node -e "const {MongoClient}=require('mongodb');const c=new MongoClient('mongodb://localhost:27017');c.connect().then(()=>{console.log('✓ MongoDB OK');c.close();}).catch(e=>console.error('✗ MongoDB Error:',e.message));"
```

### Verificar MySQL

Crear un archivo temporal `test-mysql.js`:

```javascript
require('dotenv').config();
const mysql = require('mysql2/promise');

async function test() {
  try {
    const pool = mysql.createPool({
      host: process.env.MYSQL_HOST,
      port: process.env.MYSQL_PORT,
      user: process.env.MYSQL_USER,
      password: process.env.MYSQL_PASSWORD,
      database: process.env.MYSQL_DATABASE,
    });
    
    await pool.execute('SELECT 1');
    console.log('✓ MySQL OK');
    await pool.end();
  } catch (error) {
    console.error('✗ MySQL Error:', error.message);
  }
}

test();
```

Ejecutar:

```bash
node test-mysql.js
```

## Paso 5: Estructura de MongoDB

Asegúrate de que MongoDB tenga la siguiente estructura:

**Base de datos:** `bigcommerce` (o el nombre configurado en `MONGO_DB_NAME`)

**Colección:** `products`

**Documentos:**
```json
{
  "_id": ObjectId("..."),
  "store_id": 20,
  "product_id": 123,
  // otros campos opcionales
}
```

### Verificar datos en MongoDB

```javascript
// test-mongo-data.js
require('dotenv').config();
const { MongoClient } = require('mongodb');

async function test() {
  const client = new MongoClient(process.env.MONGO_URL);
  try {
    await client.connect();
    const db = client.db(process.env.MONGO_DB_NAME);
    const count = await db.collection('products').countDocuments();
    console.log(`✓ Productos en MongoDB: ${count}`);
    
    // Mostrar un documento de ejemplo
    const sample = await db.collection('products').findOne();
    console.log('Ejemplo:', JSON.stringify(sample, null, 2));
  } catch (error) {
    console.error('✗ Error:', error.message);
  } finally {
    await client.close();
  }
}

test();
```

## Paso 6: Verificar estructura de MySQL

Asegúrate de que las siguientes tablas existan en la base de datos `prontoweb`:

### Tabla: stores
```sql
SELECT id, STOREHASH, ACCESSTOKEN, name FROM stores LIMIT 1;
```

### Tabla: products_abc
```sql
SELECT mfr, partnumber, clasif_completo FROM products_abc LIMIT 1;
```

### Tabla: special_products
```sql
SELECT brand, sku, end_date FROM special_products LIMIT 1;
```

## Paso 7: Primer Ejecución (Prueba)

Ejecuta el script para un solo producto de prueba:

```bash
node src/updateCustomFieldsInventoryTop.js 20 123
```

Donde:
- `20` es el ID de una tienda de prueba
- `123` es el ID de un producto existente en esa tienda

## Verificar Logs

Los logs se guardan en:

```
logs/updateCustomFieldsInventoryTop_YYYY-MM-DD.log
```

## Solución de Problemas Comunes

### Error: Cannot find module 'mongodb'

```bash
npm install mongodb
```

### Error: connect ECONNREFUSED (MongoDB)

- Verificar que MongoDB esté corriendo
- Verificar la URL en `MONGO_URL`

### Error: ER_ACCESS_DENIED_ERROR (MySQL)

- Verificar usuario y contraseña en `.env`
- Verificar permisos del usuario en MySQL

### Error: Tienda no encontrada

- Verificar que el STORE_CODE exista en la tabla `stores`
- Usar: `SELECT id FROM stores;` para ver las tiendas disponibles

### Error: No hay productos en MongoDB

- Verificar que existan productos con ese `store_id`
- Usar: `db.products.find({ store_id: 20 })` en MongoDB

## Ejecución en Producción

Una vez verificado que todo funciona correctamente:

### Para una tienda específica:
```bash
node src/updateCustomFieldsInventoryTop.js 20
```

### Para todas las tiendas:
```bash
node src/updateCustomFieldsInventoryTop.js all
```

### Programar ejecución automática (Windows Task Scheduler)

1. Crear un archivo `.bat`:

```batch
@echo off
cd C:\scripts\bigcommerce-updates
node src/updateCustomFieldsInventoryTop.js all >> logs/scheduled_run.log 2>&1
```

2. Configurar en Task Scheduler para ejecutar diariamente

### Programar ejecución automática (Linux/Mac - cron)

```bash
# Ejecutar todos los días a las 2 AM
0 2 * * * cd /path/to/bigcommerce-updates && node src/updateCustomFieldsInventoryTop.js all >> logs/scheduled_run.log 2>&1
```

## Recursos Adicionales

- [Documentación completa](updateCustomFieldsInventoryTop.md)
- [Parts Availability API](parts-availability-api.md)
- [MongoDB Node.js Driver](https://www.mongodb.com/docs/drivers/node/)
- [BigCommerce API Reference](https://developer.bigcommerce.com/api-reference)
