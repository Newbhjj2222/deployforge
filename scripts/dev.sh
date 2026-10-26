#!/usr/bin/env bash
# Developer entry point.   ./scripts/dev.sh {init|up|down|reset|logs|migrate|test|repo <name>|push <repo>}
set -euo pipefail
cd "$(dirname "$0")/.."
export HOST_DATA_DIR="${HOST_DATA_DIR:-$PWD/.data}"
mkdir -p .data/{workspaces,runtimes,dev-repos}
chmod 777 .data/workspaces .data/runtimes # sandbox user (uid 10001) must be able to write; contents are per-workspace

init_env() {
  if [ -f .env ]; then echo ".env already exists"; return; fi
  cp .env.example .env
  local rand; rand() { openssl rand -base64 32 | tr -d '\n'; }
  local tok;  tok()  { openssl rand -hex 24; }
  sed -i.bak \
    -e "s|^ENCRYPTION_KEYS=.*|ENCRYPTION_KEYS=1:$(rand)|" \
    -e "s|^AUTH_SECRET=.*|AUTH_SECRET=$(rand)|" \
    -e "s|^INTERNAL_TOKEN=.*|INTERNAL_TOKEN=$(tok)|" \
    -e "s|^SANDBOX_AGENT_TOKEN=.*|SANDBOX_AGENT_TOKEN=$(tok)|" \
    -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(tok)|" .env
  # keep DATABASE_URL consistent with the generated postgres password
  local pw; pw=$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2)
  sed -i.bak "s|^DATABASE_URL=.*|DATABASE_URL=postgresql://deployforge:${pw}@postgres:5432/deployforge?schema=public|" .env
  rm -f .env.bak
  echo "Created .env with freshly generated secrets."
}

case "${1:-}" in
  init) init_env ;;
  up) init_env; docker compose up --build -d; echo; echo "Dashboard:  http://app.localhost:8080   (dev login: dev@deployforge.local / deployforge-dev-1)";
      echo "Apply the build firewall on Linux hosts:  sudo infra/network/build-egress-firewall.sh" ;;
  down) docker compose down ;;
  reset) docker compose down -v; rm -rf .data/workspaces .data/runtimes ;;
  logs) docker compose logs -f --tail=100 "${@:2}" ;;
  migrate) docker compose run --rm migrate ;;
  test) npm run typecheck && npm run lint && npm test && npm run test:py ;;
  repo) # create a throwaway local git repository from an example: ./scripts/dev.sh repo static-site
      name="${2:?example name (static-site|fastapi-app)}"; dest=".data/dev-repos/$name"
      rm -rf "$dest"; cp -r "examples/$name" "$dest"
      git -C "$dest" init -q -b main && git -C "$dest" add -A && git -C "$dest" -c user.name=dev -c user.email=dev@local commit -q -m "Initial commit"
      echo "Created local repository: local/$name" ;;
  push) # simulate a signed GitHub push webhook for a local repo
      node scripts/simulate-push.mjs "${2:?repo name}" ;;
  *) sed -n '2,2p' "$0"; exit 1 ;;
esac
