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
| GET | `/v1/products/:id/manifest` | Canvas sizes, sides, masks, views and scenes |
| POST | `/v1/designs` | Validate and store a design document |
| GET | `/v1/designs/:id` | Retrieve a stored design |
| POST | `/v1/renders` | Reserved renderer entry point (currently `501`) |

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
