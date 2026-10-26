import http from 'node:http';
import pino from 'pino';
import { createStorage, loadConfig, normalizeHostname, safeEqual } from '@deployforge/core';
import { prisma, type DeploymentSettings } from '@deployforge/db';
import { route, stripPort, ttlCache, type RouteStore, type RoutedDeployment } from './router';
import { serveStatic, plain } from './static';
import { proxyToRuntime } from './proxy';

const cfg = loadConfig();
const log = pino({ level: process.env.LOG_LEVEL ?? 'info', base: { service: 'edge' } });

const toRouted = (d: { id: string; projectId: string; runtime: 'STATIC' | 'PYTHON'; artifactPrefix: string | null; settings: unknown; runtimeStatus: string } | null): RoutedDeployment | null => {
  if (!d || !d.artifactPrefix) return null;
  const s = d.settings as DeploymentSettings;
  return { id: d.id, projectId: d.projectId, runtime: d.runtime, artifactPrefix: d.artifactPrefix, spaFallback: Boolean(s.spaFallback), port: s.port ?? 8000, runtimeStatus: d.runtimeStatus };
};

const cache = ttlCache<RoutedDeployment | null>(3000);
const activeSelect = { id: true, projectId: true, runtime: true, artifactPrefix: true, settings: true, runtimeStatus: true, status: true } as const;

const store: RouteStore = {
  projectActiveByDomain: (host) =>
    cache.get(`d:${host}`, async () => {
      const dom = await prisma.domain.findUnique({
        where: { activeHostname: host },
        include: { project: { include: { activeDeployment: { select: activeSelect } } } },
      });
      // routing requires ALL of: verified+ACTIVE domain, ACTIVE project, a READY active deployment
      if (!dom || dom.status !== 'ACTIVE' || dom.project.state !== 'ACTIVE') return null;
      const a = dom.project.activeDeployment;
      return a && a.status === 'READY' ? toRouted(a) : null;
    }),
  projectActiveBySlug: (slug) =>
    cache.get(`s:${slug}`, async () => {
      const p = await prisma.project.findUnique({ where: { slug }, include: { activeDeployment: { select: activeSelect } } });
      const a = p?.state === 'ACTIVE' ? p.activeDeployment : null;
      return a && a.status === 'READY' ? toRouted(a) : null;
    }),
  readyDeploymentByPreview: (host) =>
    cache.get(`p:${host}`, async () => {
      const d = await prisma.deployment.findUnique({ where: { previewHostname: host }, select: { ...activeSelect, project: { select: { state: true } } } });
      return d && d.status === 'READY' && d.project.state === 'ACTIVE' ? toRouted(d) : null;
    }),
  isRoutableHostname: async (host) => {
    const r = await route(host, cfg.ROOT_DOMAIN, store);
    return r.kind === 'deployment';
  },
};

async function main() {
  const storage = await createStorage({
    driver: cfg.STORAGE_DRIVER, localDir: cfg.STORAGE_LOCAL_DIR, s3Bucket: cfg.S3_BUCKET, s3Region: cfg.S3_REGION,
    s3Endpoint: cfg.S3_ENDPOINT, s3AccessKeyId: cfg.S3_ACCESS_KEY_ID, s3SecretAccessKey: cfg.S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: cfg.S3_FORCE_PATH_STYLE, s3KeyPrefix: cfg.S3_KEY_PREFIX,
  });

  // ── public listener (Caddy forwards here; never exposed directly in production) ──
  const server = http.createServer(async (req, res) => {
    const started = Date.now();
    try {
      if (req.url === '/__edge/healthz') return plain(res, 200, 'ok');
      const result = await route(req.headers.host, cfg.ROOT_DOMAIN, store);
      if (result.kind === 'not_found') {
        return plain(res, 404, `${cfg.PLATFORM_NAME}: no deployment found for this address.`);
      }
      const d = result.deployment;
      if (d.runtime === 'PYTHON') {
        if (d.runtimeStatus !== 'RUNNING') return plain(res, 503, 'The application is starting or unavailable.');
        return proxyToRuntime(d.id, d.port, req, res, req.socket.remoteAddress);
      }
      await serveStatic(storage, d.artifactPrefix, d.spaFallback, req, res);
    } catch (err) {
      log.error({ err, host: req.headers.host, url: req.url }, 'request failed');
      if (!res.headersSent) plain(res, 500, 'Internal error');
      else res.destroy();
    } finally {
      log.debug({ host: req.headers.host, status: res.statusCode, ms: Date.now() - started }, 'req');
    }
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60_000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 100;
  const port = Number(process.env.EDGE_PORT ?? 8080);
  server.listen(port, '0.0.0.0', () => log.info({ port }, 'edge listening'));

  // ── admin listener: Caddy on-demand TLS "ask" (INTERNAL network only) ──
  // Caddy asks before requesting a certificate for a new hostname. We answer 200 only for hostnames the
  // platform actually serves, which stops attackers from making us request certificates for arbitrary names.
  const admin = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.pathname !== '/internal/tls-ask') return plain(res, 404, 'not found');
      if (cfg.INTERNAL_TOKEN && !safeEqual(String(req.headers['x-internal-token'] ?? ''), cfg.INTERNAL_TOKEN) && !safeEqual(u.searchParams.get('token') ?? '', cfg.INTERNAL_TOKEN)) {
        return plain(res, 401, 'unauthorized');
      }
      const domain = normalizeHostname(stripPort(u.searchParams.get('domain') ?? ''));
      if (!domain) return plain(res, 400, 'bad domain');
      // Platform subdomains: approve only hostnames that currently route to a deployment. In production prefer a
      // wildcard certificate (DNS-01) for these: previews create many hostnames and ACME rate limits apply.
      if (domain === cfg.ROOT_DOMAIN || domain.endsWith(`.${cfg.ROOT_DOMAIN}`)) {
        return (await store.isRoutableHostname(domain)) ? plain(res, 200, 'ok') : plain(res, 404, 'unknown host');
      }
      const dom = await prisma.domain.findUnique({ where: { activeHostname: domain }, select: { status: true, project: { select: { state: true } } } });
      if (dom?.status === 'ACTIVE' && dom.project.state === 'ACTIVE') return plain(res, 200, 'ok');
      return plain(res, 404, 'unknown domain');
    } catch (err) {
      log.error({ err }, 'tls-ask failed');
      plain(res, 500, 'error');
    }
  });
  admin.listen(Number(process.env.EDGE_ADMIN_PORT ?? 8081), '0.0.0.0');

  const stop = () => {
    server.close();
    admin.close();
    setTimeout(() => process.exit(0), 10_000).unref();
    void prisma.$disconnect();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

main().catch((err) => {
  console.error('fatal: edge failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
