# Architecture

```
            Internet
               │ 80/443
            ┌──▼───┐   ask: is this host verified?   ┌────────────┐
            │Caddy │────────────────────────────────▶│ edge :8081 │
            └──┬─┬─┘                                  └────────────┘
   app host    │ │ *.root / custom domains
     ┌─────────┘ └───────────┐
┌────▼────┐             ┌────▼─────┐  static from artifact store
│  web    │             │  edge    │──────────────────────────────▶ artifacts (disk/S3)
│Next.js  │             │ :8080    │  proxy (internal net)
└─┬──┬────┘             └────┬─────┘──────────▶ df-rt-<id> containers  (network: deployforge-runtime, internal)
  │  │ enqueue via outbox    │ routing lookups
  │  ▼                       ▼
  │ PostgreSQL ◀──────── worker (BullMQ consumers, outbox dispatcher, maintenance)
  │     ▲                    │ HTTP + bearer token
  └─Redis (queue, rate limit)▼
                       sandbox-agent ──docker.sock──▶ build containers (network none | build-egress) / runtimes
```

## Authority: what is truth?

| Concern | Authoritative store | Redis role |
|---|---|---|
| Deployment status, active deployment, domains, env vars, audit | PostgreSQL | none |
| Job delivery | PostgreSQL outbox row | BullMQ queue (jobId `outbox_<id>`, so redelivery is idempotent) |
| Rate limits, SSE fan-out hints | Redis | ephemeral; auth limiter fails **closed** |
| Artifacts | object store, identified by manifest + sha256 in PostgreSQL | none |

Losing Redis loses no state: the outbox dispatcher re-enqueues unsent events; workers re-validate state in PostgreSQL.

## Deployment lifecycle

`QUEUED → CLONING → INSTALLING → BUILDING → UPLOADING → READY` plus `FAILED`, `CANCELED`, `SKIPPED` (superseded) terminal states.
Every transition is a compare-and-set (`UPDATE … WHERE status IN (allowed)`); a lost race means "someone else moved it" and the worker stops.
`markReadyAndActivate` sets `READY` **and** `Project.activeDeploymentId` in one transaction, so production never points at a non-ready deployment.
A failed build never touches `activeDeploymentId`. Rollback = activate an older immutable `READY` deployment.

## Request flow for a push

1. GitHub → `POST /api/webhooks/github`; raw body HMAC verified (constant-time) before parsing; delivery id recorded (unique) → duplicates ignored.
2. Matching projects get a `Deployment` (QUEUED) and an `OutboxEvent` in one transaction; superseded queued deployments are skipped.
3. Dispatcher → BullMQ → worker `runBuild`: mints a read-only installation token scoped to one repo, asks sandbox-agent to clone, install (egress network), build (no network), then validates/uploads artifacts under `deployments/<project>/<deployment>/a<attempt>`.
4. Worker writes manifest + checksum, calls `markReadyAndActivate`. Edge picks up routing from PostgreSQL (3 s cache).

## Isolation layers
Control network ≠ build network ≠ runtime network. Only sandbox-agent has the Docker socket; only edge/agent reach runtimes; runtimes have no internet route. See [security.md](security.md).

## Scaling notes
web/edge/worker are stateless and horizontally scalable (artifact store must then be S3-compatible, not a local volume). The sandbox-agent is
per-host; multi-host scheduling is **not** implemented.
