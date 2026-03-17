# Parts Availability API Documentation

## Overview

The Parts Availability API allows you to check real-time inventory availability for parts across different stores and locations. The API resolves product information, checks inventory levels, and returns detailed stock information.

## Base URL

```
Production: http://10.1.10.21:3001
Development: http://localhost:3001
Public (ngrok): https://prontoweb-api.ngrok.app
```

## Public Access (ngrok)

When sharing this API with external projects, use:

```
https://prontoweb-api.ngrok.app/v1/parts/availability/resolve
```

Required header:

```
x-api-key: your_api_key_here
```

---

## Authentication

All requests require an API key sent in the request headers.

**Header:**
```
x-api-key: your_api_key_here
```

Contact your system administrator to obtain an API key.

---

## Endpoint

### Check Parts Availability

Resolve and check inventory availability for one or multiple products.

**URL:** `/v1/parts/availability/resolve`

**Method:** `POST`

**Content-Type:** `application/json`

**Full Production URL:** `http://10.1.10.21:3001/v1/parts/availability/resolve`

**Headers:**
```http
Content-Type: application/json
x-api-key: your_api_key_here
```

---

## Request Format

### Request Body Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `storeId` | number | Yes | Store identifier |
| `locationId` | number | Yes | Location identifier within the store |
| `products` | array | Yes | Array of products to check (1-50 items) |

### Product Object

Each product in the `products` array must include:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `brand` | string | Yes | Brand name (e.g., "BRIGGS & STRATTON") |
| `sku` | string | Conditional* | Store SKU (e.g., "BRIGGS 492932S") |
| `mpn` | string | Conditional* | Manufacturer Part Number (e.g., "492932S") |

**Note:** Either `sku` OR `mpn` is required (at least one must be provided).

---

## Request Examples

### Single Product by SKU

```bash
curl -X POST http://localhost:3001/v1/parts/availability/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key_here" \
  -d '{
    "storeId": 5,
    "locationId": 4,
    "products": [
      {
        "brand": "BRIGGS & STRATTON",
        "sku": "BRIGGS 492932S"
      }
    ]
  }'
```

### Public URL (ngrok) - Single Product by SKU

```bash
curl -X POST https://prontoweb-api.ngrok.app/v1/parts/availability/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key_here" \
  -d '{
    "storeId": 5,
    "locationId": 4,
    "products": [
      {
        "brand": "BRIGGS & STRATTON",
        "sku": "BRIGGS 492932S"
      }
    ]
  }'
```

### Single Product by MPN

```bash
curl -X POST http://localhost:3001/v1/parts/availability/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key_here" \
  -d '{
    "storeId": 5,
    "locationId": 4,
    "products": [
      {
        "brand": "BRIGGS & STRATTON",
        "mpn": "492932S"
      }
    ]
  }'
```

### Multiple Products (Batch)

```bash
curl -X POST http://localhost:3001/v1/parts/availability/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key_here" \
  -d '{
    "storeId": 5,
    "locationId": 4,
    "products": [
      {
        "brand": "BRIGGS & STRATTON",
        "sku": "BRIGGS 492932S"
      },
      {
        "brand": "KOHLER",
        "mpn": "KH-24-050-03-S"
      },
      {
        "brand": "OREGON",
        "sku": "OREGON 91-622"
      }
    ]
  }'
```

---

## Response Format

### Success Response (200 OK)

```json
{
  "success": true,
  "storeId": 5,
  "locationId": 4,
  "total": 1,
  "results": [
    {
      "input": {
        "brand": "BRIGGS & STRATTON",
        "sku": "BRIGGS 492932S",
        "mpn": null
      },
      "match": {
        "strategy": "product_match",
        "mfridIdeal": "BRS",
        "partNumberIdeal": "492932S"
      },
      "inventory": {
        "onHandAvailability": 268
      },
      "stockLevels": {
        "stockLevel1": 18,
        "stockLevel2": 63,
        "stockLevel3": 47,
        "stockLevel4": 94
      },
      "success": true,
      "error": null
    }
  ]
}
```

### Response Fields

#### Root Level

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Overall request success status |
| `storeId` | number | Store ID from request |
| `locationId` | number | Location ID from request |
| `total` | number | Total number of products processed |
| `results` | array | Array of results (one per product) |

#### Result Object

| Field | Type | Description |
|-------|------|-------------|
| `input` | object | Original input data |
| `match` | object | Product matching information |
| `inventory` | object | Inventory levels |
| `stockLevels` | object | Detailed stock by level |
| `success` | boolean | Success status for this specific product |
| `error` | string/null | Error message if failed, null if successful |

#### Match Object

| Field | Type | Description |
|-------|------|-------------|
| `strategy` | string | Matching strategy used: "product_match" or "brand_prefix" |
| `mfridIdeal` | string | Manufacturer ID in IDEAL system |
| `partNumberIdeal` | string | Part number in IDEAL system |

#### Inventory Object

| Field | Type | Description |
|-------|------|-------------|
| `onHandAvailability` | number | Total quantity available on hand |

#### Stock Levels Object

| Field | Type | Description |
|-------|------|-------------|
| `stockLevel1` | number | Stock in location 1 |
| `stockLevel2` | number | Stock in location 2 |
| `stockLevel3` | number | Stock in location 3 |
| `stockLevel4` | number | Stock in location 4 |

---

## Error Responses

### 400 Bad Request - Missing Fields

```json
{
  "success": false,
  "message": "Missing required fields: storeId, locationId, products"
}
```

### 400 Bad Request - Invalid Products Array

```json
{
  "success": false,
  "message": "products must be a non-empty array"
}
```

### 401 Unauthorized - Missing API Key

```json
{
  "success": false,
  "message": "API key is required"
}
```

### 401 Unauthorized - Invalid API Key

```json
{
  "success": false,
  "message": "Invalid API key"
}
```

### 404 Not Found - Product Not Found

Individual product error within results array:

```json
{
  "success": true,
  "total": 1,
  "results": [
    {
      "input": {
        "brand": "UNKNOWN_BRAND",
        "sku": "INVALID_SKU",
        "mpn": null
      },
      "match": null,
      "inventory": null,
      "stockLevels": null,
      "success": false,
      "error": "Product not found or brand not configured"
    }
  ]
}
```

### 500 Internal Server Error

```json
{
  "success": false,
  "message": "Internal server error"
}
```

---

## Integration Examples

### JavaScript (Node.js with Axios)

```javascript
const axios = require('axios');

async function checkPartsAvailability(products) {
  try {
    const response = await axios.post(
      'http://localhost:3001/v1/parts/availability/resolve',
      {
        storeId: 5,
        locationId: 4,
        products: products
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': 'your_api_key_here'
        }
      }
    );
    
    return response.data;
  } catch (error) {
    console.error('Error:', error.response?.data || error.message);
    throw error;
  }
}

// Usage
const products = [
  { brand: 'BRIGGS & STRATTON', sku: 'BRIGGS 492932S' }
];

checkPartsAvailability(products)
  .then(data => {
    console.log('Availability:', data);
    data.results.forEach(result => {
      if (result.success) {
        console.log(`${result.input.sku}: ${result.inventory.onHandAvailability} units available`);
      } else {
        console.log(`${result.input.sku}: ${result.error}`);
      }
    });
  })
  .catch(err => console.error(err));
```

### JavaScript (Fetch API)

```javascript
async function checkAvailability(brand, sku) {
  const response = await fetch('http://localhost:3001/v1/parts/availability/resolve', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': 'your_api_key_here'
    },
    body: JSON.stringify({
      storeId: 5,
      locationId: 4,
      products: [{ brand, sku }]
    })
  });
  
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  
  return await response.json();
}

// Usage
checkAvailability('BRIGGS & STRATTON', 'BRIGGS 492932S')
  .then(data => console.log(data))
  .catch(error => console.error('Error:', error));
```

### PHP

```php
<?php
function checkPartsAvailability($products) {
    $url = 'http://localhost:3001/v1/parts/availability/resolve';
    
    $data = [
        'storeId' => 5,
        'locationId' => 4,
        'products' => $products
    ];
    
    $options = [
        'http' => [
            'header'  => [
                'Content-Type: application/json',
                'x-api-key: your_api_key_here'
            ],
            'method'  => 'POST',
            'content' => json_encode($data)
        ]
    ];
    
    $context  = stream_context_create($options);
    $result = file_get_contents($url, false, $context);
    
    if ($result === false) {
        throw new Exception('Error checking availability');
    }
    
    return json_decode($result, true);
}

// Usage
$products = [
    ['brand' => 'BRIGGS & STRATTON', 'sku' => 'BRIGGS 492932S']
];

try {
    $availability = checkPartsAvailability($products);
    print_r($availability);
} catch (Exception $e) {
    echo 'Error: ' . $e->getMessage();
}
?>
```

### Python

```python
import requests
import json

def check_parts_availability(products):
    url = 'http://localhost:3001/v1/parts/availability/resolve'
    
    headers = {
        'Content-Type': 'application/json',
        'x-api-key': 'your_api_key_here'
    }
    
    data = {
        'storeId': 5,
        'locationId': 4,
        'products': products
    }
    
    response = requests.post(url, headers=headers, json=data)
    response.raise_for_status()
    
    return response.json()

# Usage
products = [
    {'brand': 'BRIGGS & STRATTON', 'sku': 'BRIGGS 492932S'}
]

try:
    result = check_parts_availability(products)
    print(json.dumps(result, indent=2))
    
    for product in result['results']:
        if product['success']:
            qty = product['inventory']['onHandAvailability']
            print(f"Available: {qty} units")
        else:
            print(f"Error: {product['error']}")
            
except requests.exceptions.RequestException as e:
    print(f'Error: {e}')
```

---

## Best Practices

### 1. Batch Requests

For better performance, batch multiple products in a single request instead of making individual requests:

```javascript
// ✅ Good - Single request for multiple products
const products = [
  { brand: 'BRIGGS & STRATTON', sku: 'BRIGGS 492932S' },
  { brand: 'KOHLER', sku: 'KOHLER KH-24-050-03-S' },
  { brand: 'OREGON', sku: 'OREGON 91-622' }
];
checkAvailability(products);

// ❌ Bad - Multiple requests
products.forEach(product => checkAvailability([product]));
```

### 2. Error Handling

Always handle both HTTP errors and individual product errors:

```javascript
const response = await checkAvailability(products);

response.results.forEach(result => {
  if (result.success) {
    // Product found, use inventory data
    console.log(`Available: ${result.inventory.onHandAvailability}`);
  } else {
    // Product not found or error
    console.log(`Error: ${result.error}`);
  }
});
```

### 3. Cache Results

Cache inventory results to reduce API calls:

```javascript
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedAvailability(brand, sku) {
  const key = `${brand}:${sku}`;
  const cached = cache.get(key);
  
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  const data = await checkAvailability([{ brand, sku }]);
  cache.set(key, { data, timestamp: Date.now() });
  
  return data;
}
```

### JavaScript (Axios) using Public URL (ngrok)

```javascript
const axios = require('axios');

async function checkPartsAvailabilityPublic(products) {
  const response = await axios.post(
    'https://prontoweb-api.ngrok.app/v1/parts/availability/resolve',
    {
      storeId: 5,
      locationId: 4,
      products
    },
    {
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': 'your_api_key_here'
      },
      timeout: 15000
    }
  );

  return response.data;
}
```

### 4. Rate Limiting

Respect rate limits by implementing delays between requests:

```javascript
async function checkMultipleWithDelay(productBatches, delayMs = 100) {
  const results = [];
  
  for (const batch of productBatches) {
    const result = await checkAvailability(batch);
    results.push(result);
    
    if (productBatches.indexOf(batch) < productBatches.length - 1) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  
  return results;
}
```

---

## Rate Limits

- **Recommended:** Maximum 10 requests per second
- **Products per request:** Maximum 50 products per batch
- Exceeding limits may result in throttling or temporary blocks

---

## Support

For API access, issues, or questions:
- **Technical Support:** Contact your system administrator
- **API Key Requests:** Contact IT department
- **Bug Reports:** Report to development team

---

## Changelog

### Version 1.0 (March 2026)
- Initial release
- Support for SKU and MPN lookup
- Batch processing up to 50 products
- Real-time inventory checking
- Multiple stock level reporting

---

**Last Updated:** March 9, 2026
