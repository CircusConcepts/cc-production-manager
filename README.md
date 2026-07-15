# cc-production-manager

Internal production and stock management app for **CircusConcepts**, built as a Shopify embedded Admin app. The Shopify Admin display name is **Production Manager**.

The app tracks physical manufactured items (ropes, straps, etc.) by serial number. It is **read-only toward Shopify** — all production data is stored in PostgreSQL.

## Shopify safety rules

- The app currently requests **`read_products` only**.
- The app does **not** write to Shopify products, orders, inventory, customers, themes, metafields, or metaobjects.
- **Production SKUs** are local app database records (`Product` model in Prisma). They are not Shopify products.
- Creating a **Production SKU** does **not** create a Shopify product.
- **Serialized Items** are local app database records — one row per physical manufactured item.
- Creating, editing, or deleting serialized items and production SKUs affects **only this app database**, never Shopify.
- **CSV imports** write only to PostgreSQL. Uploaded files are parsed in memory and are not stored on disk.
- **Stock quantity** is never stored directly. It is calculated by counting `SerializedItem` rows where `status = IN_STOCK`.
- No `read_orders` scope, no order webhooks, and no Shopify product sync are enabled yet.
- **No customer PII**: customer data for production orders (name, address, notes) is stored only in this app's PostgreSQL database for local production management. It is never sent to Shopify.

## Local development

### Prerequisites

- Node.js 20.19+ or 22.12+
- [Shopify CLI](https://shopify.dev/docs/apps/tools/cli/getting-started)
- Docker (optional, for local PostgreSQL)

### 1. Install dependencies

```bash
npm install
```

### 2. Start PostgreSQL

```bash
docker compose up -d
```

Local database URL (from `docker-compose.yml`):

```
postgresql://ccpm:ccpm_password@localhost:5433/ccpm_dev?schema=public
```

### 3. Configure environment

Copy the example file and fill in values:

```bash
cp .env.example .env
```

For local dev, Shopify CLI usually injects `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, and `SHOPIFY_APP_URL` when you run `shopify app dev`.

### 4. Run migrations

```bash
npx prisma migrate deploy
npx prisma generate
```

### 5. Start the app

```bash
shopify app dev
```

### Useful scripts

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `shopify app dev` | Local development with tunnel |
| `build` | `react-router build` | Production build |
| `start` | `react-router-serve ./build/server/index.js` | Start production server |
| `typecheck` | `react-router typegen && tsc --noEmit` | TypeScript check |
| `setup` | `prisma generate && prisma migrate deploy` | DB setup for deploy |

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `SHOPIFY_API_KEY` | Yes | App API key from Partner Dashboard |
| `SHOPIFY_API_SECRET` | Yes | App API secret |
| `SHOPIFY_APP_URL` | Yes | Public app URL (no trailing slash), e.g. `https://cc-production-manager.onrender.com` |
| `SCOPES` | Yes | `read_products` |
| `NODE_ENV` | Yes | `development` locally, `production` on Render |
| `PORT` | Render | Set automatically by Render; server listens on this port |
| `ORDER_UPLOAD_DIR` | Production | Absolute or relative path for production-order document storage. Must point to a Render Persistent Disk mount in production. |
| `MAX_ORDER_DOCUMENT_BYTES` | No | Per-file upload limit in bytes (default `10485760` / 10 MB) |
| `MAX_ORDER_DOCUMENTS` | No | Maximum documents per order (default `10`) |
| `MAX_ORDER_UPLOAD_TOTAL_BYTES` | No | Combined per-request upload limit (default `52428800` / 50 MB) |

See `.env.example` for a starter template.

### Production order documents

Production orders support JPG, PNG, WebP, and PDF attachments. Files are stored on disk under `ORDER_UPLOAD_DIR` using shop- and order-scoped paths. Only a safe relative `storageKey` is saved in PostgreSQL.

**Local development:** defaults to `./storage/order-documents` (gitignored).

**Render production:** attach a **Render Persistent Disk** to the web service before enabling uploads. Set `ORDER_UPLOAD_DIR` to a subdirectory on that mount, for example:

```
/opt/render/project/src/storage/order-documents
```

(or the mount path shown in the Render dashboard, such as `/var/data/order-documents`).

A single persistent disk is suitable for the current single-instance deployment. If the app later scales to multiple web instances, replace this filesystem storage with shared object storage (S3, Cloudflare R2, etc.) without changing the database model.

## Database setup

Prisma is configured for **PostgreSQL**:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

### Models

- `Session` — Shopify OAuth sessions
- `Shop` — installed shops
- `Product` — SKU catalog per shop
- `SerializedItem` — one row per physical item
- `ImportBatch` — CSV import history
- `AuditLog` — change history
- `ProductionOrder` / `ProductionOrderLine` / `ProductionOrderDocument` — local production order management (not synced to Shopify)

### Migrations

Migrations live in `prisma/migrations/`. **Do not delete them.**

Apply in any environment:

```bash
npx prisma migrate deploy
```

## Render deployment

### Architecture

```
Shopify Admin (embedded) → Render Web Service → Render PostgreSQL
```

### 1. Create Render PostgreSQL

1. In Render: **New → PostgreSQL**
2. Copy the **Internal Database URL**
3. Use it as `DATABASE_URL` on the web service (internal URL keeps traffic on Render's private network)

### 2. Create Render Web Service

1. **New → Web Service**
2. Connect your GitHub repo
3. Runtime: **Node**
4. **Build command:**

   ```bash
   npm install && npx prisma generate && npx prisma migrate deploy && npm run build
   ```

5. **Start command:**

   ```bash
   npm run start
   ```

6. **Environment variables** (set in Render dashboard):

   | Key | Value |
   |-----|-------|
   | `DATABASE_URL` | Internal Postgres URL from step 1 |
   | `SHOPIFY_API_KEY` | From Partner Dashboard |
   | `SHOPIFY_API_SECRET` | From Partner Dashboard |
   | `SHOPIFY_APP_URL` | `https://your-service.onrender.com` |
   | `SCOPES` | `read_products` |
   | `NODE_ENV` | `production` |
   | `ORDER_UPLOAD_DIR` | Path on Render Persistent Disk mount (see above) |
   | `MAX_ORDER_DOCUMENT_BYTES` | `10485760` (optional) |
   | `MAX_ORDER_DOCUMENTS` | `10` (optional) |
   | `MAX_ORDER_UPLOAD_TOTAL_BYTES` | `52428800` (optional) |

7. **Attach a Render Persistent Disk** to the web service (recommended size: 1 GB or more). Mount it (for example at `/var/data`) and set `ORDER_UPLOAD_DIR` to a folder on that mount.

8. Deploy and confirm the service is healthy at your Render URL.

### 3. Update Shopify app config

After Render is live, update `shopify.app.toml` (or Partner Dashboard):

```toml
application_url = "https://your-service.onrender.com"

[auth]
redirect_urls = [ "https://your-service.onrender.com/auth/callback" ]
```

Then deploy config to Shopify:

```bash
shopify app deploy
```

Or update URLs manually in the [Partner Dashboard](https://partners.shopify.com).

### 4. Webhooks

Only these webhooks are registered:

- `app/uninstalled`
- `app/scopes_update`

No order webhooks yet.

## Shopify app config

| Setting | Value |
|---------|-------|
| Embedded | `true` |
| Scopes | `read_products` |
| Auth prefix | `/auth` |
| OAuth callback | `https://<your-host>/auth/callback` |

## CSV import behavior

Historical production CSVs can be uploaded from **CSV Import** in the app.

- Parsed **server-side** from `request.formData()` — not stored on disk
- Each row = one `SerializedItem` (unique serial number per shop)
- Products are created automatically if SKU does not exist
- Import modes: skip duplicates, update existing, or fail on duplicates
- Results saved to `ImportBatch` with row-level errors and skips
- `sourceType` = `IMPORT` for all imported rows
- Default status: `IN_STOCK` (no order #) or `SHIPPED` (order # present)

Supported column names are flexible and case-insensitive. See the import page help section for examples.

## Verification

```bash
npx prisma format
npx prisma validate
npx prisma generate
npm run typecheck
npm run build
```

## License

Private — CircusConcepts internal use.
