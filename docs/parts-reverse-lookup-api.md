# Parts Reverse Lookup API Documentation

## Overview

The Parts Reverse Lookup API resolves IDEAL parts (`mfrid` + `partnumber`) to matching BigCommerce products stored in MongoDB.

It is designed to return product identifiers per store so external systems can run mass product updates in BigCommerce.

---

## Base URL

```
Production: http://10.1.10.21:3001
Development: http://localhost:3001
Public (ngrok): https://prontoweb-api.ngrok.app
```

---

## Authentication

All requests require an API key in the headers.

**Header:**
```http
x-api-key: your_api_key_here
```

> This endpoint uses the same key as Parts Availability (`PARTS_AVAILABILITY_API_KEY`).

---

## Endpoint

### Reverse Resolve Parts

Given a list of IDEAL parts, find matching MongoDB products with `availability != "disabled"` and return identifiers required for downstream updates.

**URL:** `/v1/parts/reverse/resolve`

**Method:** `POST`

**Content-Type:** `application/json`

**Full Production URL:** `http://10.1.10.21:3001/v1/parts/reverse/resolve`

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
| `parts` | array | Yes | Array of parts to resolve |
| `clearence` | string | No | Optional filter applied to `brandsandstores.clearence` |
| `newproduct` | string | No | Optional filter applied to `brandsandstores.newproduct` |

### Part Object

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `mfrid` | string | Yes | IDEAL manufacturer id |
| `partnumber` | string | Yes | IDEAL part number |

---

## Matching Rules

For each input part:

1. Resolve candidate manufacturers using `brands.mfrid` + `brands.mfr_equiv`.
2. Query `prontoweb.brandsandstores` for candidate `mfrid` values.
3. If `clearence` and/or `newproduct` are provided, apply those filters in `brandsandstores`.
4. Search MongoDB (`Prontoweb.Products`) using:
   - `STOREID` from `brandsandstores.storeid`
   - `BRAND` equivalent to `brandsandstores.brandbc` (case-insensitive)
   - `availability != "disabled"`
5. Compare Mongo `MPN` with input `partnumber` after normalization:
   - Remove spaces and hyphens on both sides.
   - If `brands.sufsku` exists for the manufacturer, remove that prefix from the normalized `partnumber` before comparison.

---

## Request Examples

### Basic Request

```bash
curl -X POST http://localhost:3001/v1/parts/reverse/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key_here" \
  -d '{
    "clearence": "y",
    "newproduct": "n",
    "parts": [
      { "mfrid": "BRS", "partnumber": "492932S" },
      { "mfrid": "SHI", "partnumber": "S1234" }
    ]
  }'
```

### Request with Optional Filters

```bash
curl -X POST http://localhost:3001/v1/parts/reverse/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key_here" \
  -d '{
    "clearence": "y",
    "newproduct": "n",
    "parts": [
      { "mfrid": "BRS", "partnumber": "492932S" }
    ]
  }'
```

### Public URL (ngrok)

```bash
curl -X POST https://prontoweb-api.ngrok.app/v1/parts/reverse/resolve \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key_here" \
  -d '{
    "parts": [
      { "mfrid": "BRS", "partnumber": "492932S" }
    ]
  }'
```

---

## Response Format

### Success Response (200 OK)

```json
{
  "success": true,
  "clearence": "y",
  "newproduct": "n",
  "totalRequested": 1,
  "totalMatches": 2,
  "results": [
    {
      "input": {
        "mfrid": "BRS",
        "partnumber": "492932S"
      },
      "candidateMfrIds": ["BRS", "SHIN"],
      "storesChecked": 3,
      "matches": [
        {
          "STOREID": 5,
          "BRAND": "BRIGGS & STRATTON",
          "MPN": "492932S",
          "SKU": "BRIGGS 492932S",
          "ID": 12345
        },
        {
          "STOREID": 8,
          "BRAND": "BRIGGS & STRATTON",
          "MPN": "492932S",
          "SKU": "BRS-492932S",
          "ID": 88771
        }
      ],
      "totalMatches": 2,
      "success": true,
      "error": null
    }
  ]
}
```

### Root Fields

| Field | Type | Description |
|-------|------|-------------|
| `success` | boolean | Overall request status |
| `clearence` | string/null | Applied filter value |
| `newproduct` | string/null | Applied filter value |
| `totalRequested` | number | Number of input parts |
| `totalMatches` | number | Sum of all matched Mongo products |
| `results` | array | Per-part detailed result |

### Result Fields

| Field | Type | Description |
|-------|------|-------------|
| `input` | object | Original input (`mfrid`, `partnumber`) |
| `candidateMfrIds` | array | Manufacturer ids considered (includes `mfr_equiv`) |
| `storesChecked` | number | `brandsandstores` rows checked |
| `matches` | array | Matched Mongo products |
| `totalMatches` | number | Number of matches for this part |
| `success` | boolean | Per-part success status |
| `error` | string/null | Error message if this part failed |

### Match Object

| Field | Type | Description |
|-------|------|-------------|
| `STOREID` | number | Store id |
| `BRAND` | string | Mongo brand (BigCommerce brand name) |
| `MPN` | string | Product MPN |
| `SKU` | string | Product SKU |
| `ID` | number | BigCommerce product id |

---

## Error Responses

### 400 Bad Request - Invalid Input

```json
{
  "success": false,
  "message": "parts must be a non-empty array"
}
```

```json
{
  "success": false,
  "message": "parts[0]: mfrid is required"
}
```

```json
{
  "success": false,
  "message": "parts[0]: partnumber is required"
}
```

### 401 Unauthorized

```json
{
  "success": false,
  "message": "Unauthorized"
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

## Notes

- `clearence` is intentionally spelled as in your current MySQL column naming.
- If `clearence` or `newproduct` are missing/blank, they are ignored.
- This API does not update `brandsandstores.expectedreceiveddate`.
- A request can return `success: true` with zero matches if no Mongo products satisfy the rules.
