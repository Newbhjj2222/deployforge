# DeployForge

A self-hostable, Vercel-inspired deployment platform: connect a Git repository, build it in an isolated sandbox, publish an
immutable deployment, serve it on a preview URL / production URL / custom domain, and roll back instantly.

> **Status: v0.1 – reference implementation, NOT production-verified.** Read [Verification status](#verification-status) before
> trusting any part of it. Running untrusted code safely is hard; read [docs/security.md](docs/security.md) before exposing it.

## What it does

| Area | Implementation |
|---|---|
| Control plane | Next.js (App Router) dashboard + REST API, Auth.js sessions, Argon2id passwords, Origin-check CSRF defence, rate limiting |
| Git integration | GitHub App (JWT → short-lived read-only installation token), HMAC-SHA256 verified webhooks, idempotent by delivery id |
| Orchestration | PostgreSQL = source of truth; transactional outbox → BullMQ (Redis) for delivery only; compare-and-set state machine |
| Builds | Python sandbox-agent is the only holder of the Docker socket; hardened containers (non-root, cap-drop ALL, limits, no network during build step) |
| Artifacts | Immutable, sha256-checksummed manifest; local-disk or S3-compatible storage |
| Serving | `edge` service: host routing, static files from manifest, reverse proxy to Python runtimes on an internal network |
| Domains / TLS | TXT-challenge verification, unique active-hostname index (no takeover), Caddy on-demand TLS gated by an `ask` endpoint |
| Secrets | AES-256-GCM envelope encryption with keyring + AAD, never returned by API, redacted from logs |
| Logs | Persisted per deployment, live via SSE, secret redaction |
| Rollback | Re-activates an earlier immutable deployment atomically |
| Runtimes | Static sites and Python (ASGI/WSGI) apps. Node server runtimes are **not** implemented. |

## Quick start (development)

Requirements: Docker + Compose v2, Node 22, git, Linux or macOS (Docker Desktop: see docs/development.md).

```bash
./scripts/dev.sh init            # creates .env with generated secrets
./scripts/dev.sh up              # builds and starts postgres, redis, web, worker, edge, sandbox-agent, caddy
./scripts/dev.sh repo static-site   # copies examples/static-site into a local git repo the platform can "clone"
open http://app.localhost:8080   # sign in: dev@deployforge.local / deployforge-dev-1  (seeded; dev only)
```

Then: **GitHub → Use local dev repositories → New project → select `local/static-site` → Deploy.**
`./scripts/dev.sh push static-site` commits a change and fires a correctly signed push webhook.
Run the end-to-end acceptance script against the stack: `node scripts/acceptance.mjs`.

Other commands: `./scripts/dev.sh down | reset | logs | migrate | test`; `npm test`, `npm run test:py`, `npm run db:test`.

## Repository layout

```
apps/web        Next.js dashboard + API + webhook receiver
apps/worker     BullMQ consumers: build pipeline, outbox dispatcher, maintenance schedulers
apps/edge       Public request router (static + Python proxy) and Caddy `ask` endpoint
packages/core   Pure logic: crypto, redaction, state machine, webhook verify, paths, domains, detection, storage, GitHub client
packages/db     Prisma schema, SQL migration, authorization helpers, deployment/domain/env services
services/sandbox-agent   Python FastAPI service that runs hardened Docker containers
infra/          Caddy configs, build-egress firewall script
examples/       static-site, fastapi-app
docs/           architecture, security, api, github-app, operations, development, checklist
```

## Verification status

This was produced in an environment **without access to the npm/PyPI registries or Docker**. Be precise about what that means.

**Executed and passing in the authoring environment**
- `packages/core` unit tests – 64 passing (crypto, redaction, state machine, webhook HMAC, path safety, domains, detection, storage, GitHub client).
- `apps/edge` tests – 10 passing (host routing, manifest-based static serving, traversal handling).
- `apps/web` schema/CSRF tests – 4 passing.
- `packages/db/test/constraints.sql` – 24 checks passing against a real PostgreSQL 16 (migration applied from scratch).
- `services/sandbox-agent` safety tests – 29 passing (executed with a minimal pytest stand-in, not real pytest).

**Written but never executed or compiled here** (treat as untested until your CI says otherwise)
- The Next.js app (pages, API routes, middleware), Auth.js wiring, `next build`.
- Prisma Client usage in `packages/db` services, worker pipeline, webhook handler DB logic, BullMQ wiring.
- The Docker runner, build-egress firewall script, Caddy configs, S3 storage driver, Dockerfile builds, both compose files.
- `scripts/acceptance.mjs`, Playwright `e2e/`, `apps/worker/test`, `services/sandbox-agent/tests/test_api.py`, lint, prettier, `tsc` for packages that need installed deps.
- `.github/workflows/ci.yml` – never run. Expect first-run fixes.

**Known gaps** – see [docs/checklist.md](docs/checklist.md) (SSO/MFA, billing/quotas UI, Node server runtimes, multi-host scheduling,
stronger isolation than plain Docker, metrics/alerting, S3 driver testing).

Next step for you: `npm install && npm run db:generate && npm run typecheck && npm test`, then `./scripts/dev.sh up` and
`node scripts/acceptance.mjs`. Fix whatever those reveal; they are the real source of truth.

## License
Choose one before publishing (none is included).
