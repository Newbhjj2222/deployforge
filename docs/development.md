# Development

- `./scripts/dev.sh init|up|down|reset|logs|migrate|test|repo <example>|push <name>`
- Local-git mode: the worker/agent clone from `.data/dev-repos/<name>` (mounted read-only); repos appear as `local/<name>` under synthetic installation 0. **Dev only.**
- `HOST_DATA_DIR` must be the absolute host path of `./.data` because the sandbox-agent starts sibling containers through the host Docker daemon (bind paths are host paths). `scripts/dev.sh` exports it automatically (defaults to `$PWD/.data`); if you run `docker compose` directly, export it yourself.
- Tests: `npm test` (vitest, per workspace), `npm run test:py`, `npm run db:test` (needs `DATABASE_URL`), `node scripts/acceptance.mjs` (needs the stack up), `npx playwright test` (install `@playwright/test` first).
- Docker Desktop on macOS/Windows: bind-mount host path semantics differ; if clones fail, put `HOST_DATA_DIR` inside a shared path.
