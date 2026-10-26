# API (session-cookie authenticated JSON; mutations require same-origin)

| Method & path | Purpose |
|---|---|
| GET `/api/health` | liveness/readiness |
| POST `/api/auth/register` | create account |
| GET/POST `/api/projects` | list / create project |
| GET/PATCH/DELETE `/api/projects/:id` | project |
| GET/POST `/api/projects/:id/deployments` | list / trigger deployment |
| GET/POST `/api/projects/:id/env`, DELETE `/api/projects/:id/env/:key` | env vars (values write-only) |
| GET/POST `/api/projects/:id/domains` | custom domains |
| POST `/api/domains/:id/verify`, DELETE `/api/domains/:id` | verify / remove |
| GET `/api/deployments/:id` | status |
| GET `/api/deployments/:id/logs` | persisted logs; `Accept: text/event-stream` for live SSE |
| POST `/api/deployments/:id/cancel` / `rollback` | cancel / re-activate |
| GET `/api/github/installations`, `/repositories`; POST `/connect`, `/detect`, `/setup` | GitHub integration |
| POST `/api/webhooks/github` | signed webhook (no session) |

Errors: `{ "error": { "code": string, "message": string } }`; foreign resources → 404; validation → 422; rate limit → 429 + `Retry-After`.
