
# syntax=docker/dockerfile:1.7

# Shared image recipe for web, worker, edge and migrate.
FROM node:22-bookworm-slim AS base

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
       openssl \
       ca-certificates \
       git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NEXT_TELEMETRY_DISABLED=1

# Install dependencies for the entire npm workspace.
FROM base AS deps

COPY package.json tsconfig.base.json ./

COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/

COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY apps/edge/package.json apps/edge/

RUN --mount=type=cache,target=/root/.npm \
    npm install --include=dev --no-audit --no-fund

# Copy source and generate Prisma Client.
FROM deps AS source

COPY packages/core packages/core
COPY packages/db packages/db
COPY apps/web apps/web
COPY apps/worker apps/worker
COPY apps/edge apps/edge

# Verify that Prisma CLI and client are installed in the workspace.
RUN npm ls @prisma/client prisma --workspace=@deployforge/db

# Generate Prisma Client using the actual schema.
RUN npm run generate --workspace=@deployforge/db

# Build the Next.js application.
FROM source AS web-build

ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
ENV ENCRYPTION_KEYS=1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
ENV ENCRYPTION_KEY_ACTIVE=1
ENV AUTH_SECRET=build-time-only

RUN npm run build --workspace=@deployforge/web

# Production web service.
FROM base AS web

ENV NODE_ENV=production

RUN useradd -r -u 10010 -m app

COPY --from=web-build --chown=app /app/apps/web/.next/standalone ./
COPY --from=web-build --chown=app /app/apps/web/.next/static ./apps/web/.next/static

USER app

ENV PORT=3000
ENV HOSTNAME=0.0.0.0

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/web/server.js"]

# Background worker service.
FROM source AS worker

ENV NODE_ENV=production

RUN useradd -r -u 10011 -m app \
    && mkdir -p /data \
    && chown app /data

USER app

CMD ["npx", "tsx", "apps/worker/src/index.ts"]

# Edge routing service.
FROM source AS edge

ENV NODE_ENV=production

RUN useradd -r -u 10012 -m app \
    && mkdir -p /data \
    && chown app /data

USER app

EXPOSE 8080 8081

HEALTHCHECK --interval=15s --timeout=3s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:8080/__edge/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npx", "tsx", "apps/edge/src/index.ts"]

# Database migrations and optional seeding.
FROM source AS migrate

CMD ["sh", "-c", "npx prisma migrate deploy --schema packages/db/prisma/schema.prisma && if [ \"$SEED\" = \"true\" ]; then npx tsx packages/db/src/seed.ts; fi"]
