# wp-pod

Backend foundation for Hongxiu's WordPress POD designer. It exposes locally archived POD product manifests and validates portable design documents without calling SDS at runtime.

## What is implemented

- Health endpoint and Docker health check
- Product discovery from the archived `pod-assets/products/<id>` structure
- Normalized all-pieces and single-piece manifests
- Local serving of masks, scene files and PSD-layer assets
- Versioned design JSON validation and temporary design persistence
- API-key protection for write endpoints and configurable CORS
- Explicit renderer boundary: `/v1/renders` returns `501` until the local Vetrina-compatible adapter is implemented

The service makes no runtime requests to SDS. Archived assets are mounted read-only.

## API

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/health` | Service and asset-mount status |
| GET | `/v1/products` | Products with captured POD data |
| GET | `/v1/catalog` | Queryable catalogue index (`q`, `category`, `status`, `limit`, `offset`, `includeRemoved=1`) |
| GET | `/v1/catalog/stats` | Counts per category and capture status |
| GET | `/v1/catalog/:id` | One indexed product |
| POST | `/v1/catalog/refresh` | Rebuild the index from the archive |
| GET | `/v1/products/:id/manifest` | Canvas sizes, sides, masks, views and scenes |
| POST | `/v1/designs` | Validate and store a design document |
| GET | `/v1/designs/:id` | Retrieve a stored design |
| POST | `/v1/renders` | Reserved renderer entry point (currently `501`) |
| POST | `/v1/intakes` | Store a flattened POD design (per-side PNG + mode) for later SDS ordering |
| GET | `/v1/intakes` | List intakes (`status`, `date`, `productId`, `limit`, `offset`) |
| GET | `/v1/intakes/stats` | Daily intake stats (`days`, `date`) — new vs. not-yet-pushed-to-SDS |
| GET | `/v1/intakes/:id` | Intake detail incl. bound orders |
| GET | `/v1/intakes/:id/sides/:sideId.png` | Flattened side PNG |
| POST | `/v1/intakes/:id/orders` | Bind size/quantity (simulate now, `webhook` later) |
| POST | `/v1/intakes/:id/sds` | Worker write-back (`cart_added` / `failed` / …) |
| POST | `/v1/shopify/orders-webhook` | Reserved Shopify `orders/create` webhook (HMAC verified) |
| GET | `/ops/intakes` | Read-only ops dashboard for daily intake stats |

## POD intakes (设计拍平 → 与 SDS 交互)

Designer "Complete design" stores one intake per design: the flattened PNG of every side, the
mode (`all` / `single`), product and design ids. **No SDS interaction happens here** — a separate
worker picks pending intakes up later and drives SDS (see `POD/_work/sds-inject-multipiece.js`).

- Order binding: real purchases arrive through `/v1/shopify/orders-webhook`
  (`line_item.properties._pod_intake_id` / `_pod_design_id` plus size/quantity). During testing use
  `POST /v1/intakes/:id/orders` with `{"size":"M","quantity":2,"source":"simulate"}` — never touches Shopify.
- Daily stats: `GET /v1/intakes/stats?days=14` (or the `/ops/intakes` page) shows per-day created /
  pending / cart_added / failed / ordered counts, i.e. how much is still not pushed to SDS.
- Side images live in Postgres (`pod_intakes_sides.bytes`), so no extra storage mount is required.

## Local development

```bash
cp .env.example .env
npm install
npm test
npm run dev
```

Set `POD_ASSETS_ROOT` to the existing `pod-assets` directory. Example on Windows PowerShell:

```powershell
$env:POD_ASSETS_ROOT='E:\cc\wearhongxiu\wordpress\products\pod-assets'
npm run dev
```

Then open `http://localhost:3000/v1/products/106652/manifest`.

## Docker / future Coolify deployment

The application expects a read-only volume at `/assets`. In Coolify, create one application from this repository, configure the environment variables, and mount or sync the archived assets separately. Do not commit the large `pod-assets` directory to Git.

## Next implementation milestone

1. Add S3-compatible upload storage for user artwork.
2. Persist designs and jobs in PostgreSQL; queue render jobs in Redis.
3. Implement the local renderer adapter using the captured scene/PSD-layer data.
4. Return generated previews through `/v1/renders/:jobId`.
5. Connect the WordPress designer to the manifest, design and render endpoints.
