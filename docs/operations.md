# Operations (single-host reference)

**Deploy:** `docker compose -f docker-compose.prod.yml up -d --build`; run `sudo infra/network/build-egress-firewall.sh` on the host first, then `scripts/verify-egress.sh`.
Required secrets: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `AUTH_SECRET`, `ENCRYPTION_KEYS`/`ENCRYPTION_KEY_ACTIVE`, `SANDBOX_AGENT_TOKEN`, `INTERNAL_TOKEN`, GitHub App values, `APP_HOST`, `ROOT_DOMAIN`, `ACME_EMAIL`, `HOST_DATA_DIR`.
Set `REDIS_URL=redis://:${REDIS_PASSWORD}@redis:6379` accordingly. Use a wildcard certificate for `*.ROOT_DOMAIN` (DNS-01 Caddy build) to avoid Let's Encrypt limits.

**Backups:** PostgreSQL (`pg_dump` nightly + WAL if needed) and the artifact store. Redis is rebuildable. Back up `ENCRYPTION_KEYS` separately — without them env vars are unrecoverable. Test restores.

**Key rotation:** add a new key id to `ENCRYPTION_KEYS`, set `ENCRYPTION_KEY_ACTIVE`, re-encrypt in a maintenance script, then retire the old key.

**Upgrades:** build new images, run `migrate` (forward-only SQL), roll web/worker/edge. Migrations are hand-written; run `npm run migrate:check -w @deployforge/db` in CI to detect drift.

**Failed jobs:** BullMQ failed set acts as the DLQ; state is in PostgreSQL, so re-trigger by creating a new deployment. Stuck deployments are failed by the worker's maintenance sweep.

**Monitoring (not built-in):** scrape `/api/health`, alert on queue depth, outbox age (`OutboxEvent` rows unsent > 1 min), disk usage of `.data`, and cert expiry. Structured JSON logs go to stdout.

**Scaling & limits:** per-project limits live in settings/config (`MAX_*`, timeouts in `.env.example`). Multi-host build scheduling and per-tenant quotas are not implemented.

**Cleanup:** the maintenance scheduler prunes old artifacts (keeping active + N recent), log retention, orphaned runtimes, and deleted-project data.
