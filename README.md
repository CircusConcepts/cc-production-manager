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
- **No customer PII**: no customer names, emails, phones, or addresses stored.

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

See `.env.example` for a starter template.

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
- `ProductionOrder` / `ProductionOrderLine` — reserved for future order sync

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

7. Deploy and confirm the service is healthy at your Render URL.

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
