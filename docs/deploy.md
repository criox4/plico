# Deploying Plico

| Part | Where | How it ships |
|---|---|---|
| Web app (PWA) | Vercel, `plico.space` | Vercel builds every push: `main` is production, `dev` gets a preview URL |
| API | Any Linux host with Docker, `api.plico.space` behind Cloudflare | `.github/workflows/deploy-api.yml` on push to `main` |
| Database migrations | Postgres, schema `splittr` | By hand: `npm run db:migrate` (never automatic) |
| Phone apps | App Store / Play Store | Not automated yet |

**Branches:** work on `dev` (CI runs, Vercel preview); merge `dev` → `main` to release. Only `main` deploys.

## The API pipeline
`push to main` → CI (`npm test`, `npm run build`) → Docker image to `ghcr.io/criox4/plico-api:<sha>` and `:latest` →
SSH to the host → `ops/deploy/deploy.sh <sha>` pulls it, restarts, and waits for `/health`; if it never passes, it
starts the previous image again and the run fails. Run it by hand from Actions → Deploy API → Run workflow.

Moving the API to another host: set it up as below, update the three `DEPLOY_*` secrets, point the `api` DNS record at
it. The image and `.env` are the same everywhere.

### GitHub settings
- **Secrets** (Settings → Secrets and variables → Actions): `DEPLOY_HOST` (the host's address), `DEPLOY_SSH_KEY` (a
  private key used only for deploys; its public half is in the host's `authorized_keys`), `DEPLOY_KNOWN_HOSTS`
  (`ssh-keyscan <host>` output, so the runner can't be pointed at an impostor).
- **Environment** `production`, where you can add required reviewers if deploys should wait for approval.

### Host setup (once)
```sh
mkdir -p /opt/plico && cd /opt/plico          # compose.yml and deploy.sh arrive with each deploy
# .env: the API's secrets (see below). Never committed; mode 600.
bash cloudflare-ips.sh                          # from ops/deploy: which addresses are Cloudflare's
certbot certonly --nginx -d api.plico.space     # needs the DNS record to exist
cp nginx-api.conf /etc/nginx/sites-available/plico-api && ln -s ../sites-available/plico-api /etc/nginx/sites-enabled/
nginx -t && systemctl reload nginx
```
nginx only accepts connections from Cloudflare's addresses and takes the visitor's IP from `CF-Connecting-IP`, so
nobody can skip Cloudflare or fake their address for rate limiting. Cloudflare's SSL mode should be **Full (strict)**.

### The API's `.env` in production
Everything in `.env.example`, plus:
```sh
NODE_ENV=production
PUBLIC_URL=https://plico.space              # the web app: CORS, trusted origins, links in emails
BETTER_AUTH_URL=https://api.plico.space     # where sign-in callbacks land
CLIENT_IP_HEADER=x-real-ip                  # set by nginx from Cloudflare's header
OTEL_EXPORTER_OTLP_ENDPOINT=…               # optional: see docs/observability.md
OTEL_EXPORTER_OTLP_HEADERS=…
```

## The web app on Vercel
Import the repo in Vercel (`vercel.json` holds the build settings), add the domain `plico.space`, and set:
`VITE_API_URL=https://api.plico.space`, `VITE_PUBLIC_URL=https://plico.space`, and optionally `VITE_SENTRY_DSN`
and `SENTRY_AUTH_TOKEN`. The app calls the API directly; `plico.space` and `api.plico.space` are the same site, so
the sign-in cookie works across them.

## Migrations
Hand-written SQL in `prisma/migrations`. Apply from a trusted machine with `DIRECT_URL` pointing at the database:
```sh
npm run db:migrate
```
Deploy the API after the migration when a release needs both.
