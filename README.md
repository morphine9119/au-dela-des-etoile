# Au-delà des Étoiles — Premium Spiritual Consultation Marketplace

## Architecture Summary
- **Frontend**: React 19 + TypeScript + Vite + Tailwind CSS v4 + React Router (static build served by Cloudflare Workers Assets)
- **Backend**: runs entirely on Cloudflare — one SQLite-backed **Durable Object** (`worker/backend.ts`) hosts the SQL database, the REST API (`server/`) and the real-time WebSocket chat (hibernating WebSockets on `/ws`). A thin Worker (`worker/index.ts`) forwards `/api/*`, `/ws`, `/uploads/*` to it.
- **Security**: HTTP-only signed JWT cookies (HS256), `bcryptjs` password hashing, server-side RBAC (`client`, `expert`, `admin`, `staff`), Zod validation, sliding-window rate limiting, integer minor-currency (`cents`) financial ledger, and audit logging.
- **Uploads**: expert avatars are stored in the database (`uploaded_files`, max 1.9 MB each) and served from `/uploads/expert-avatars/*`.

Why a single Durable Object? Durable Object SQLite is synchronous and strongly consistent, so the original business logic (atomic wallet debits, double-booking prevention, per-message billing) keeps its exact semantics. It is capable of far more than a small marketplace needs (10 GB database); if you outgrow it, shard or move heavy tables to D1.

## Requirements
- Node.js 22.12 or newer, npm
- A free Cloudflare account

## Local development
```bash
npm install
cp .dev.vars.example .dev.vars   # local-only settings; APP_ENV=development seeds demo accounts
npm run dev                      # builds the UI and runs the real Workers runtime on http://localhost:8787
npm test                         # API/security/finance test-suite (Node + node:sqlite)
npm run lint                     # TypeScript check
```
`npm run dev:ui` starts the Vite dev server alone (UI only, no API).

## Deploy to Cloudflare
1. `npm install` then `npx wrangler login`
2. Set the required secrets (they are stored encrypted by Cloudflare, never in the code):
   ```bash
   npx wrangler secret put JWT_SECRET       # 32+ random characters
   npx wrangler secret put ADMIN_EMAIL      # first admin account
   npx wrangler secret put ADMIN_PASSWORD   # 12+ characters
   ```
   Generate a secret with: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
3. `npm run deploy` (= build + `wrangler deploy`). The first deploy creates the Durable Object and its database automatically.
4. Optional: add your domain in the dashboard under **Workers & Pages → astro-celeste → Settings → Domains & Routes**.

### Deploy from GitHub instead (no local CLI)
Dashboard → **Workers & Pages → Create → Import a repository**, then use build command `npm run build` and deploy command `npx wrangler deploy`. Add `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` under **Settings → Variables and Secrets**.

### Environment variables
| Name | Where | Purpose |
|---|---|---|
| `JWT_SECRET` | secret (required) | Signs session tokens, 32+ chars |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | secret | Creates/updates the production admin (password 12+ chars) |
| `ADMIN_FIRST_NAME`, `ADMIN_LAST_NAME` | `wrangler.jsonc` vars | Admin display name |
| `APP_ENV` | local only | `development` enables demo accounts and sandbox top-ups. **Never set it in production** — the app is production by default. |
| `ENABLE_DEMO_SANDBOX` | optional | `true` enables sandbox wallet top-ups in production |
| `STRIPE_*`, `CMI_*`, `PAYTABS_*`, `PAYPAL_*` | secrets, optional | Live payment providers |
| `TWILIO_*`, `VONAGE_*` | secrets, optional | Live telephony |

### Limits to be aware of
- SQLite-backed Durable Objects are available on the Cloudflare Free plan, with daily usage quotas (see Cloudflare's current Durable Objects pricing/limits). Hibernating WebSockets keep idle chat connections cheap.
- Avatars are capped at ~1.9 MB (Durable Object row limit). For larger media, add an R2 bucket.
- All data lives in one Durable Object. There is no built-in export/backup endpoint yet — plan one before going live with real customer data.

## Demo Accounts (Development Seed)
- Demo accounts are available only in development; production startup disables all seeded demo accounts.
- Development startup restores the seeded demo credentials and reactivates demo users soft-deleted in the sandbox.
- **Verified Experts**: `celeste@maison-astralis.demo`, `marcus@maison-astralis.demo`, `nadia@maison-astralis.demo` / `AstralisExpert2026!`
- **Clients**: `claire@maison-astralis.demo`, `julien@maison-astralis.demo` / `AstralisClient2026!`

## Feature Verification Status
- **Implemented & Tested**: Public catalog, search/filter/sort/URL persistence, expert profile & availability slot generation, client registration/login/RBAC, double-booking prevention, real-time WebSocket chat & server-side per-message billing, financial split & commission rules, idempotent sandbox wallet credits, expert application & admin approval conversion, verified-only reviews, loyalty points & coupons, editorial blog/horoscopes/tarot encyclopedia, multilingual EN/FR/AR + RTL.
- **Awaiting External Provider Credentials**: Live external card/wallet settlement (Stripe, PayTabs, CMI, PayPal) and live PSTN voice routing (Twilio/Vonage) intentionally display provider-setup-required states rather than simulating live external calls.
