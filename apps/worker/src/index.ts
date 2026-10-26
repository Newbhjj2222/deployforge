import { Queue, Worker, type Job } from 'bullmq';
import {
  ActivateJobDataSchema,
  BUILD_JOB_OPTIONS,
  BuildJobDataSchema,
  MAINTENANCE_JOBS,
  OUTBOX_TYPES,
  QUEUES,
  jobIdFor,
} from '@deployforge/core';
import { activateDeployment, dispatchOutbox, loadEnvForDeployment, prisma, type DeploymentSettings } from '@deployforge/db';
import { createContext, type Ctx } from './context';
import { runBuild, startPythonRuntime } from './pipeline';
import {
  artifactCleanup,
  domainRecheck,
  expirePendingDomains,
  logRetention,
  projectCleanup,
  runtimeReconcile,
  tlsCheck,
} from './maintenance';

async function main() {
  const ctx = await createContext();
  const { log, cfg } = ctx;
  const connection = ctx.redis;

  const buildQueue = new Queue(QUEUES.build, { connection });
  const activateQueue = new Queue(QUEUES.activate, { connection });
  const maintenanceQueue = new Queue(QUEUES.maintenance, { connection });

  // ── build jobs ──────────────────────────────────────────────────────────────
  const buildWorker = new Worker(
    QUEUES.build,
    async (job: Job) => {
      const data = BuildJobDataSchema.parse(job.data);
      const maxAttempts = job.opts.attempts ?? 1;
      const attempt = job.attemptsMade + 1;
      const outcome = await runBuild(ctx, data.deploymentId, attempt, attempt >= maxAttempts);
      log.info({ deploymentId: data.deploymentId, outcome: outcome.status, attempt }, 'build finished');
      return outcome;
    },
    { connection, concurrency: Number(process.env.WORKER_CONCURRENCY ?? 2), lockDuration: 60_000, stalledInterval: 30_000, maxStalledCount: 2 },
  );

  // ── activation jobs (python rollback) ───────────────────────────────────────
  const activateWorker = new Worker(
    QUEUES.activate,
    async (job: Job) => {
      const data = ActivateJobDataSchema.parse(job.data);
      const d = await prisma.deployment.findUnique({ where: { id: data.deploymentId } });
      if (!d || d.status !== 'READY' || !d.artifactPrefix) return { skipped: true };
      if (d.runtime === 'PYTHON') {
        const env = await loadEnvForDeployment(cfg.keyring, d.projectId, d.environment, 'runtime');
        await startPythonRuntime(ctx, d.id, d.artifactPrefix, d.settings as unknown as DeploymentSettings, env);
      }
      return activateDeployment(d.id, { force: true, actorId: data.requestedByUserId ?? null });
    },
    { connection, concurrency: 2 },
  );

  // ── maintenance + project cleanup ──────────────────────────────────────────
  const maintenanceWorker = new Worker(
    QUEUES.maintenance,
    async (job: Job) => {
      switch (job.name) {
        case MAINTENANCE_JOBS.domainRecheck: return domainRecheck(ctx);
        case MAINTENANCE_JOBS.expirePendingDomains: return expirePendingDomains();
        case MAINTENANCE_JOBS.tlsCheck: return tlsCheck(ctx);
        case MAINTENANCE_JOBS.artifactCleanup: return artifactCleanup(ctx);
        case MAINTENANCE_JOBS.logRetention: return logRetention(ctx);
        case MAINTENANCE_JOBS.runtimeReconcile: return runtimeReconcile(ctx);
        case OUTBOX_TYPES.projectCleanup: return projectCleanup(ctx, String((job.data as { projectId: string }).projectId));
        default: log.warn({ name: job.name }, 'unknown maintenance job');
      }
    },
    { connection, concurrency: 1 },
  );
  const schedule = (id: string, everyMs: number) => maintenanceQueue.upsertJobScheduler(id, { every: everyMs }, { name: id, opts: { removeOnComplete: 50, removeOnFail: 100 } });
  await schedule(MAINTENANCE_JOBS.domainRecheck, 15 * 60_000);
  await schedule(MAINTENANCE_JOBS.expirePendingDomains, 6 * 3600_000);
  await schedule(MAINTENANCE_JOBS.tlsCheck, 30 * 60_000);
  await schedule(MAINTENANCE_JOBS.artifactCleanup, 3600_000);
  await schedule(MAINTENANCE_JOBS.logRetention, 6 * 3600_000);
  await schedule(MAINTENANCE_JOBS.runtimeReconcile, 60_000);

  for (const w of [buildWorker, activateWorker, maintenanceWorker]) {
    w.on('failed', (job, err) => log.warn({ queue: w.name, jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message }, 'job failed'));
    w.on('error', (err) => log.error({ err }, 'worker error'));
  }

  // ── outbox dispatcher: PostgreSQL intent -> BullMQ delivery (idempotent via jobId) ──
  let stopping = false;
  const deliver = async (row: { id: string; type: string; aggregateId: string; payload: unknown }) => {
    const jobId = jobIdFor(row.id);
    switch (row.type) {
      case OUTBOX_TYPES.deploymentCreated:
        await buildQueue.add('build', { deploymentId: row.aggregateId, outboxId: row.id }, { ...BUILD_JOB_OPTIONS, jobId });
        return;
      case OUTBOX_TYPES.deploymentActivate:
        await activateQueue.add('activate', { ...(row.payload as object), deploymentId: row.aggregateId, outboxId: row.id }, { jobId, attempts: 3, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100 });
        return;
      case OUTBOX_TYPES.projectCleanup:
        await maintenanceQueue.add(OUTBOX_TYPES.projectCleanup, { projectId: row.aggregateId }, { jobId, attempts: 8, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 100 });
        return;
      default:
        throw new Error(`unknown outbox type ${row.type}`);
    }
  };
  const loop = (async () => {
    while (!stopping) {
      try {
        const n = await dispatchOutbox(deliver);
        await sleep(n > 0 ? 100 : 1000);
      } catch (err) {
        log.error({ err }, 'outbox dispatch failed');
        await sleep(3000);
      }
    }
  })();

  log.info({ workerId: ctx.workerId, storage: ctx.storage.driver }, 'worker started');

  // ── graceful shutdown: stop taking jobs, let active builds finish (bounded), then exit ──
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 60_000);
    await Promise.allSettled([buildWorker.close(), activateWorker.close(), maintenanceWorker.close(), loop]);
    await Promise.allSettled([buildQueue.close(), activateQueue.close(), maintenanceQueue.close()]);
    await prisma.$disconnect();
    ctx.redis.disconnect();
    clearTimeout(force);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export type { Ctx };

main().catch((err) => {
  console.error('fatal: worker failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
