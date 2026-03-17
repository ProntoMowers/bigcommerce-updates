1) Contexto del proyecto

Este repositorio contiene scripts en Node.js para interactuar con BigCommerce y ejecutar actualizaciones sobre productos y/o categorías.
El proyecto también consulta MySQL (prontoweb) como base puente (credenciales, configuración por tienda, marcas, etc.) y usa BigQuery para analítica (datasets por tienda + dataset GENERAL).

2) Estructura obligatoria

Todo script nuevo debe crearse en: src/

Todo script debe generar logs en: logs/

Configuración sensible nunca hardcodeada:

Credenciales de BD MySQL salen de .env

Credenciales / cliente de BigQuery salen del archivo: config/bigquery.js

3) Interfaz por consola (CLI) obligatoria

Todos los scripts se ejecutan así:

node src/<script>.js STORE_CODE [PRODUCT_OR_CATEGORY_ID]

Reglas:

Si no se pasa STORE_CODE: el script debe terminar con error y mostrar uso + sugerir all.

Si STORE_CODE es all: el script debe:

consultar MySQL (stores) y obtener todos los IDs

ejecutar el proceso para cada tienda

Si PRODUCT_OR_CATEGORY_ID viene:

aplicar cambios solo a ese producto o categoría

Si no viene:

procesar todos los productos o categorías (según corresponda)

4) Logging obligatorio

Usar el helper de logger del proyecto (no console.log como logging principal).

Cada script debe registrar:

inicio + parámetros recibidos

store(s) a procesar

cantidades procesadas (total, actualizados, omitidos, errores)

duración total

errores con contexto (storeId, endpoint, entityId, etc.)

El archivo de log debe incluir el nombre del script y la fecha.

5) MySQL (prontoweb) – reglas

Conectarse a MySQL usando .env (nunca credenciales hardcodeadas).

Para cada tienda, leer credenciales de BigCommerce desde stores:

STOREHASH

ACCESSTOKEN

Si el script necesita dataset de BigQuery por tienda:

leer dataset_bigcommerce desde la tabla stores

Tablas comunes usadas en lógica:

stores (credenciales BigCommerce + dataset_bigcommerce)

brands

brandsandstores (relación storeid + mfrid + brandbc + brandid + brandprefijo)

6) BigCommerce – reglas de integración

Todas las llamadas a la API deben usar storeHash + accessToken obtenidos desde MySQL.

Implementar manejo de errores HTTP robusto:

loggear status code + payload cuando sea posible

reintentar solo cuando tenga sentido (p. ej. 429/5xx) con backoff

Evitar updates innecesarios:

comparar data actual vs data deseada antes de enviar PATCH/PUT

Si se actualizan categorías de un producto:

recordar que al enviar array de categorías se sobrescribe la lista completa (cuidado con side effects). 

Modelo de Datos Pronto Mowers

7) BigQuery – reglas

El cliente de BigQuery debe importarse desde config/bigquery.js (no instanciar credenciales dentro del script).

Existen datasets por tienda (según stores.dataset_bigcommerce) y un dataset común:

bigcommerce-analitics.GENERAL con tablas compartidas (p. ej. products_visits, products_abc). 

Modelo de Datos Pronto Mowers

Consultas deben estar parametrizadas/escapadas cuando aplique, y loggear:

query ejecutada (o una versión truncada)

número de filas devueltas

8) Convenciones de código

Node.js (CommonJS require) consistente con el proyecto.

Funciones pequeñas y reutilizables:

getAllStoreIds()

getStoreCredentials(storeId)

processStore(storeId, optionalEntityId)

Manejo correcto de recursos:

cerrar conexiones/pools cuando termine el script

liberar estructuras grandes en memoria cuando ya no se usen

Validación de parámetros:

si falta STORE_CODE, mostrar ayuda y terminar con process.exit(1)

Nombres de tablas y columnas siempre en inglés (si se crean nuevas).

9) Reglas de negocio importantes (marcas/SKU)

Cuando se requiera matchear productos por marca/SKU entre BigCommerce y sistemas internos:

brandsandstores.brandbc es el nombre de marca en BigCommerce (por tienda). 

Modelo de Datos Pronto Mowers

Si brandsandstores.brandprefijo existe:

remover ese prefijo del sku antes de buscar equivalencias internas

Si brands.sufsku existe:

intentar búsqueda con y sin sufijo (según la lógica definida del proyecto)

10) Estándar mínimo de salida del script

Al finalizar, el script debe imprimir (y loggear):

stores procesadas

total entidades leídas

total actualizadas

total omitidas (sin cambios)

total errores

duración total