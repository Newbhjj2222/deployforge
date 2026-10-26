import tls from 'node:tls';
import dns from 'node:dns/promises';
import { prisma, verifyDomain, loadEnvForDeployment, type DeploymentSettings } from '@deployforge/db';
import type { Ctx } from './context';
import { startPythonRuntime } from './pipeline';

const HOUR = 3600_000;

function makeResolver() {
  const r = new dns.Resolver({ timeout: 4000, tries: 2 });
  const servers = process.env.DNS_RESOLVERS?.split(',').map((s) => s.trim()).filter(Boolean);
  r.setServers(servers?.length ? servers : ['1.1.1.1', '8.8.8.8']);
  return (name: string) => r.resolveTxt(name);
}
export const resolveTxt = makeResolver();

/** Re-verify ACTIVE domains hourly (dangling-record protection) and retry PENDING ones. */
export async function domainRecheck(ctx: Ctx): Promise<number> {
  const due = await prisma.domain.findMany({
    where: { status: { in: ['PENDING_VERIFICATION', 'ACTIVE', 'SUSPENDED'] }, OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: new Date(Date.now() - 50 * 60_000) } }] },
    take: 200,
    orderBy: { lastCheckedAt: { sort: 'asc', nulls: 'first' } },
  });
  let n = 0;
  for (const d of due) {
    try {
      await verifyDomain(d.id, resolveTxt);
      n++;
    } catch (err) {
      ctx.log.warn({ err, domainId: d.id }, 'domain recheck failed');
    }
  }
  return n;
}

/** Pending domains nobody verified within 7 days are removed (frees names, limits abuse). */
export async function expirePendingDomains(): Promise<number> {
  const r = await prisma.domain.deleteMany({ where: { status: 'PENDING_VERIFICATION', createdAt: { lt: new Date(Date.now() - 7 * 24 * HOUR) } } });
  return r.count;
}

/** Probe the public TLS listener to learn whether a certificate was actually issued (production only). */
export async function tlsCheck(ctx: Ctx): Promise<number> {
  const addr = ctx.cfg.EDGE_TLS_PROBE_ADDR;
  if (!addr) return 0; // dev: no public TLS listener; status stays as reported by the verification step
  const [host, portStr] = addr.split(':');
  const domains = await prisma.domain.findMany({ where: { status: 'ACTIVE' }, take: 200 });
  for (const d of domains) {
    const result = await new Promise<{ ok: boolean; validTo?: Date }>((resolve) => {
      const sock = tls.connect({ host, port: Number(portStr ?? 443), servername: d.hostname, timeout: 8000, rejectUnauthorized: true }, () => {
        const cert = sock.getPeerCertificate();
        sock.end();
        resolve({ ok: sock.authorized, validTo: cert?.valid_to ? new Date(cert.valid_to) : undefined });
      });
      sock.on('error', () => resolve({ ok: false }));
      sock.on('timeout', () => {
        sock.destroy();
        resolve({ ok: false });
      });
    });
    const expiring = result.validTo && result.validTo.getTime() - Date.now() < 14 * 24 * HOUR;
    await prisma.domain.update({
      where: { id: d.id },
      data: {
        tlsCheckedAt: new Date(),
        tlsStatus: result.ok ? (expiring ? 'EXPIRING' : 'ACTIVE') : d.tlsStatus === 'ACTIVE' ? 'FAILED' : 'PENDING',
        tlsExpiresAt: result.validTo ?? d.tlsExpiresAt,
      },
    });
  }
  return domains.length;
}

/** Delete artifacts of failed/canceled deployments, stale non-active attempt prefixes, and old logs. */
export async function artifactCleanup(ctx: Ctx): Promise<number> {
  let removed = 0;
  const dead = await prisma.deployment.findMany({
    where: { status: { in: ['FAILED', 'CANCELED'] }, artifactPrefix: { not: null }, finishedAt: { lt: new Date(Date.now() - HOUR) } },
    take: 100,
  });
  for (const d of dead) {
    if (!d.artifactPrefix) continue;
    await ctx.storage.deletePrefix(d.artifactPrefix).catch(() => undefined);
    await prisma.deployment.update({ where: { id: d.id }, data: { artifactPrefix: null, artifactChecksum: null } });
    if (d.runtime === 'PYTHON') await ctx.sandbox.stopRuntime(d.id).catch(() => undefined);
    removed++;
  }
  // abandoned attempt prefixes: <projectId>/<deploymentId>/a<N> that the deployment row does not reference
  const cutoff = Date.now() - 24 * HOUR;
  const recent = await prisma.deployment.findMany({ where: { createdAt: { lt: new Date(cutoff) } }, select: { id: true, projectId: true, artifactPrefix: true }, orderBy: { createdAt: 'asc' }, take: 300 });
  for (const d of recent) {
    const base = `deployments/${d.projectId}/${d.id}`;
    for (const p of await ctx.storage.listPrefixes(base)) {
      if (p !== d.artifactPrefix) {
        await ctx.storage.deletePrefix(p).catch(() => undefined);
        removed++;
      }
    }
  }
  return removed;
}

export async function logRetention(ctx: Ctx): Promise<number> {
  const r = await prisma.deploymentLog.deleteMany({ where: { ts: { lt: new Date(Date.now() - ctx.cfg.LOG_RETENTION_DAYS * 24 * HOUR) } } });
  return r.count;
}

/** Keep Python runtimes aligned with the database: restart the active one if its container vanished. */
export async function runtimeReconcile(ctx: Ctx): Promise<number> {
  const active = await prisma.deployment.findMany({
    where: { runtime: 'PYTHON', status: 'READY', artifactPrefix: { not: null }, OR: [{ activeFor: { isNot: null } }, { createdAt: { gt: new Date(Date.now() - 24 * HOUR) } }] },
    take: 100,
  });
  let fixed = 0;
  for (const d of active) {
    const info = await ctx.sandbox.runtimeStatus(d.id).catch(() => undefined);
    if (info === undefined) continue; // agent unreachable: do not guess
    const isActive = await prisma.project.count({ where: { activeDeploymentId: d.id } });
    if (info && info.healthy) {
      if (d.runtimeStatus !== 'RUNNING') await prisma.deployment.update({ where: { id: d.id }, data: { runtimeStatus: 'RUNNING' } });
      continue;
    }
    if (isActive) {
      try {
        const env = await loadEnvForDeployment(ctx.cfg.keyring, d.projectId, d.environment, 'runtime');
        await startPythonRuntime(ctx, d.id, d.artifactPrefix!, d.settings as unknown as DeploymentSettings, env);
        fixed++;
      } catch (err) {
        ctx.log.error({ err, deploymentId: d.id }, 'runtime restart failed');
        await prisma.deployment.update({ where: { id: d.id }, data: { runtimeStatus: 'FAILED' } });
      }
    } else if (d.runtimeStatus === 'RUNNING') {
      await prisma.deployment.update({ where: { id: d.id }, data: { runtimeStatus: 'STOPPED' } });
    }
  }
  return fixed;
}

/** Project deletion: stop runtimes, remove every artifact, then hard-delete the project. */
export async function projectCleanup(ctx: Ctx, projectId: string): Promise<void> {
  const project = await prisma.project.findUnique({ where: { id: projectId }, include: { deployments: { select: { id: true, runtime: true } } } });
  if (!project || project.state !== 'DELETING') return;
  for (const d of project.deployments) if (d.runtime === 'PYTHON') await ctx.sandbox.stopRuntime(d.id).catch(() => undefined);
  await ctx.storage.deletePrefix(`deployments/${projectId}`).catch((err) => {
    ctx.log.warn({ err, projectId }, 'artifact delete failed');
    throw err; // retry: never drop the row while artifacts may remain
  });
  await prisma.project.delete({ where: { id: projectId } });
  ctx.log.info({ projectId }, 'project deleted');
}
