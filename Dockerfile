# syntax=docker/dockerfile:1.7
# One image recipe for the three Node services. Build a target with:  docker build --target web|worker|edge|migrate .
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates git && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS deps

COPY package.json tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/db/prisma packages/db/prisma/
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/edge/package.json apps/edge/

RUN --mount=type=cache,target=/root/.npm \
    npm install --include=dev --no-audit --no-fund

FROM deps AS source
COPY packages packages
COPY apps apps
RUN npm run db:generate

FROM deps AS source

COPY packages packages
COPY apps apps

RUN npm ls @prisma/client prisma -w @deployforge/db

RUN npm run db:generate

FROM source AS web-build
# placeholders are only used at build time so `next build` can import server modules; real values come at runtime
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build ENCRYPTION_KEYS=1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= ENCRYPTION_KEY_ACTIVE=1 AUTH_SECRET=build-time-only
RUN npm run build -w @deployforge/web

FROM base AS web
ENV NODE_ENV=production
RUN useradd -r -u 10010 -m app
COPY --from=web-build --chown=app /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=app /app/apps/web/.next/static ./apps/web/.next/static
USER app
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/web/server.js"]

FROM source AS worker
ENV NODE_ENV=production
RUN useradd -r -u 10011 -m app && mkdir -p /data && chown app /data
USER app
CMD ["npx", "tsx", "apps/worker/src/index.ts"]

FROM source AS edge
ENV NODE_ENV=production
RUN useradd -r -u 10012 -m app && mkdir -p /data && chown app /data
USER app
EXPOSE 8080 8081
HEALTHCHECK --interval=15s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:8080/__edge/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npx", "tsx", "apps/edge/src/index.ts"]

FROM source AS migrate
CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/db/prisma/schema.prisma && if [ \"$SEED\" = \"true\" ]; then npx tsx packages/db/src/seed.ts; fi"]
