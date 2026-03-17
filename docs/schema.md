6. Inventario y Disponibilidad (Inventory Integration)
6.1 Table: PRODUCTLOCATION (Firebird - IDEAL)

Almacena la cantidad disponible de un producto en cada ubicación del inventario.

Uso principal en los servicios internos para calcular inventario real disponible.

CREATE TABLE PRODUCTLOCATION (
    MFRID VARCHAR(4) NOT NULL,
    PARTNUMBER VARCHAR(20) NOT NULL,
    LOCATIONID SMALLINT NOT NULL,
    ONHANDAVAILABLEQUANTITY DOUBLE PRECISION,
    CONSTRAINT PRODUCTLOCATION_PK PRIMARY KEY (MFRID, PARTNUMBER, LOCATIONID)
);

Campo clave:

Campo	Descripción
MFRID	Código de fabricante
PARTNUMBER	Número de parte
LOCATIONID	Ubicación de inventario
ONHANDAVAILABLEQUANTITY	Cantidad disponible

Uso en el sistema:

El servicio InventoryService suma el campo:

SUM(ONHANDAVAILABLEQUANTITY)

para obtener el inventario disponible en IDEAL.

6.2 Table: provider_products (MySQL - prontoweb)

Contiene el inventario disponible en proveedores externos.

Se utiliza para calcular la disponibilidad total cuando el inventario interno es insuficiente.

CREATE TABLE provider_products (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mfrid VARCHAR(4),
    sku VARCHAR(50),
    supplierid INT,
    onhandqty INT
);

Campos relevantes:

Campo	Descripción
mfrid	Código de fabricante
sku	Número de parte
supplierid	Proveedor asociado
onhandqty	Inventario disponible en proveedor

Uso en el sistema:

providerQty = SUM(onhandqty)
6.3 Cálculo de disponibilidad

La disponibilidad total de un producto se calcula como:

Total Availability = onhandQty + providerQty

Donde:

onhandQty → inventario interno (Firebird PRODUCTLOCATION)

providerQty → inventario proveedor (MySQL provider_products)

7. Matching de Productos (MySQL - prontoweb)
7.1 Table: product_match

Tabla utilizada para mapear productos de BigCommerce con productos internos de IDEAL.
Se usa para encontrar equivalencias de brand + part_number recibidos desde BigCommerce/Dialogflow y traducirlos a:

mfr_ideal

partnumber_ideal

equivalencias alternativas (*_ideal2)

Uso principal en:

partsAvailabilityWebhook

InventoryService

procesos batch de matching

-- product_match definition

CREATE TABLE product_match (
  id INT AUTO_INCREMENT PRIMARY KEY,
  brandbc VARCHAR(100),
  sku VARCHAR(100),

  mfr_ideal VARCHAR(4),
  partnumber_ideal VARCHAR(20),

  mfr_ideal2 VARCHAR(4),
  partnumber_ideal2 VARCHAR(20),

  notes TEXT,
  usercreation VARCHAR(20),
  userupdate VARCHAR(20),

  created_at TIMESTAMP NULL,
  updated_at TIMESTAMP NULL
);

Campos relevantes:

Campo	Descripción
brandbc	Marca en BigCommerce (texto)
sku	SKU en BigCommerce
mfr_ideal	MFRID equivalente en IDEAL
partnumber_ideal	PARTNUMBER equivalente en IDEAL
mfr_ideal2	MFRID alterno (equivalente)
partnumber_ideal2	PARTNUMBER alterno
notes	Nota de cómo se hizo el match
usercreation	system o usuario que creó
userupdate	usuario que actualizó (si existe)

Valores comunes en notes:

Exact match

Match with Sku-suf

Match with equivalent mfr

Match with sku-suf and equivalent mfr

Regla de actualización de registros (cuando el script lo permite):

Si el registro ya existe, solo se actualiza si:

usercreation = 'system'

userupdate IS NULL

7.2 Table: product_no_match

Registra productos de BigCommerce que no pudieron asociarse con IDEAL.

-- product_no_match definition

CREATE TABLE product_no_match (
  id INT AUTO_INCREMENT PRIMARY KEY,
  brand VARCHAR(100),
  sku VARCHAR(100),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

Uso:

Auditoría de productos sin correspondencia.

Fuente para revisión manual / backoffice.

7.3 Flujo de Matching
Input (BigCommerce / Dialogflow)

brand (texto, típicamente viene de brandsandstores.brandbc)

part_number (SKU / número de parte)

Paso 1: Normalización de SKU

Si brandsandstores.brandprefijo existe, removerlo del SKU

trim() de espacios

Si brands.sufsku existe, intentar búsqueda con y sin sufijo (según lógica del proyecto)

Paso 2: Buscar en product_match

Buscar coincidencia por:

brandbc

sku

Si existe → usar mfr_ideal + partnumber_ideal.

Si no existe → registrar en product_no_match.

8. Integración con BigCommerce

Los productos de BigCommerce se identifican principalmente por:

Campo	Descripción
brand_id	ID de marca en BigCommerce
sku	SKU del producto
id	product_id

La marca se traduce usando la tabla:

brandsandstores

Campos importantes:

Campo	Descripción
storeid	tienda
brandbc	nombre de marca en BigCommerce
mfrid	fabricante en IDEAL
brandprefijo	prefijo usado en SKU

Reglas de normalización del SKU:

Si existe brandprefijo, eliminarlo del SKU.

Eliminar espacios al inicio y final.

Buscar en IDEAL con MFRID + PARTNUMBER.

9. Flujo de disponibilidad de partes

Proceso usado por:

partsAvailabilityWebhook

orderStatusWebhook

InventoryService

Paso 1

Recibir:

brand
part_number
Paso 2

Buscar equivalencia en:

product_match
Paso 3

Consultar inventario:

Firebird:

PRODUCTLOCATION

MySQL:

provider_products
Paso 4

Calcular disponibilidad final

onhandQty
providerQty
shippingDays
10. Regla de cálculo de Shipping Days

El cálculo depende del inventario disponible.

Si:

providerQty > 0

entonces

shippingDays = onhandDays + providerDays

De lo contrario:

shippingDays = manufacturerDays + onhandDays

Los valores se obtienen de la tabla:

suppliers