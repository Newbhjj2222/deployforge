import { Prisma, type DeploymentEnvironment, type DeploymentStatus, type DeploymentTrigger } from '@prisma/client';
import {
  AppError,
  OUTBOX_TYPES,
  assertTransition,
  isCancelable,
  isSha,
  newPreviewHostname,
  progressFor,
  statesAllowing,
  type DeploymentStatus as CoreStatus,
} from '@deployforge/core';
import { prisma } from './client';
import { audit } from './audit';
import type { DeploymentSettings } from './types';

export interface CreateDeploymentInput {
  projectId: string;
  environment: DeploymentEnvironment;
  trigger: DeploymentTrigger;
  branch: string;
  commitSha: string;
  commitMessage?: string | null;
  commitAuthor?: string | null;
  createdById?: string | null;
  /** Retried operations (webhook redelivery, double clicks) reuse the same key and get the same row. */
  idempotencyKey: string;
  rootDomain: string;
  maxPerDay: number;
}

/**
 * Create a deployment + its outbox event + first log line in ONE transaction.
 * Nothing is queued directly: the worker's outbox dispatcher delivers the event to BullMQ, so a crash
 * between "row written" and "job queued" can never lose a deployment.
 */
export async function createDeployment(input: CreateDeploymentInput) {
  if (!isSha(input.commitSha)) throw new AppError('bad_request', 'Invalid commit SHA');

  const existing = await prisma.deployment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
  if (existing) return { deployment: existing, created: false as const };

  try {
    return await prisma.$transaction(async (tx) => {
      const project = await tx.project.findUnique({
        where: { id: input.projectId },
        include: { connection: true },
      });
      if (!project || project.state !== 'ACTIVE') throw new AppError('not_found', 'Project not found');
      if (project.connection?.disabledAt) {
        throw new AppError('conflict', 'The repository connection is disabled (GitHub installation was removed or suspended).');
      }

      const since = new Date(Date.now() - 24 * 3600 * 1000);
      const recent = await tx.deployment.count({ where: { projectId: project.id, createdAt: { gte: since } } });
      if (recent >= input.maxPerDay) {
        throw new AppError('quota_exceeded', `Deployment limit reached (${input.maxPerDay} per 24 hours).`);
      }

      const settings: DeploymentSettings = {
        framework: project.framework,
        runtime: project.runtime,
        installCommand: project.installCommand,
        buildCommand: project.buildCommand,
        outputDirectory: project.outputDirectory,
        startCommand: project.startCommand,
        pythonVersion: project.pythonVersion,
        nodeVersion: project.nodeVersion,
        port: project.port,
        healthCheckPath: project.healthCheckPath,
        spaFallback: project.spaFallback,
        rootDirectory: project.connection?.rootDirectory ?? '',
        repo: project.connection
          ? {
              fullName: project.connection.fullName,
              githubRepoId: project.connection.githubRepoId.toString(),
              installationId: project.connection.installationRef,
            }
          : null,
      };

      const deployment = await tx.deployment.create({
        data: {
          projectId: project.id,
          environment: input.environment,
          trigger: input.trigger,
          branch: input.branch,
          commitSha: input.commitSha,
          commitMessage: input.commitMessage?.slice(0, 300) ?? null,
          commitAuthor: input.commitAuthor?.slice(0, 120) ?? null,
          createdById: input.createdById ?? null,
          idempotencyKey: input.idempotencyKey,
          previewHostname: newPreviewHostname(project.slug, input.rootDomain),
          settings: settings as unknown as Prisma.InputJsonValue,
          runtime: project.runtime,
          status: 'QUEUED',
        },
      });
      await tx.deploymentLog.create({
        data: { deploymentId: deployment.id, seq: 0, level: 'INFO', stream: 'SYSTEM', message: `Deployment queued for ${input.commitSha.slice(0, 7)} (${input.branch})` },
      });
      await tx.outboxEvent.create({
        data: { type: OUTBOX_TYPES.deploymentCreated, aggregateId: deployment.id, payload: { deploymentId: deployment.id } },
      });
      await tx.usageRecord.create({
        data: { orgId: project.orgId, projectId: project.id, deploymentId: deployment.id, metric: 'DEPLOYMENT', quantity: 1n },
      });
      await audit(tx, {
        orgId: project.orgId,
        actorId: input.createdById,
        action: 'deployment.create',
        targetType: 'deployment',
        targetId: deployment.id,
        metadata: { trigger: input.trigger, environment: input.environment, sha: input.commitSha.slice(0, 7) },
      });
      return { deployment, created: true as const };
    });
  } catch (err) {
    // a concurrent request with the same idempotency key won the race: return its row
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const row = await prisma.deployment.findUnique({ where: { idempotencyKey: input.idempotencyKey } });
      if (row) return { deployment: row, created: false as const };
    }
    throw err;
  }
}

export interface TransitionExtra {
  failureCode?: string | null;
  failureReason?: string | null;
  data?: Prisma.DeploymentUpdateManyMutationInput;
}

/**
 * Compare-and-set status change: succeeds only if the row is still in one of the states the state
 * machine allows to move to `to` (and, when given, one of `from`). Returns false when another
 * actor (cancel request, duplicate job) got there first - callers treat that as "stop".
 */
export async function transitionDeployment(
  deploymentId: string,
  to: DeploymentStatus,
  opts: { from?: DeploymentStatus[]; extra?: TransitionExtra } = {},
): Promise<boolean> {
  const allowed = statesAllowing(to as CoreStatus) as DeploymentStatus[];
  const from = opts.from ? opts.from.filter((s) => allowed.includes(s)) : allowed;
  if (from.length === 0) {
    // surface programmer errors loudly
    assertTransition((opts.from?.[0] ?? 'READY') as CoreStatus, to as CoreStatus);
  }
  const now = new Date();
  const terminal = to === 'READY' || to === 'FAILED' || to === 'CANCELED';
  const res = await prisma.deployment.updateMany({
    where: { id: deploymentId, status: { in: from } },
    data: {
      status: to,
      progress: progressFor(to as CoreStatus),
      ...(to === 'CLONING' ? { startedAt: now } : {}),
      ...(to === 'READY' ? { readyAt: now } : {}),
      ...(terminal ? { finishedAt: now } : {}),
      ...(to === 'FAILED' ? { failureCode: opts.extra?.failureCode ?? 'build_failed', failureReason: opts.extra?.failureReason ?? 'Deployment failed' } : {}),
      ...(opts.extra?.data ?? {}),
    },
  });
  return res.count === 1;
}

/** Cancel: QUEUED goes straight to CANCELED, in-progress goes to CANCELING (the worker finishes the job). */
export async function requestCancel(deploymentId: string, actorId: string | null) {
  return prisma.$transaction(async (tx) => {
    const d = await tx.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
    if (!d) throw new AppError('not_found', 'Deployment not found');
    if (!isCancelable(d.status as CoreStatus)) throw new AppError('conflict', `Deployment is already ${d.status}`);
    const now = new Date();
    let next: DeploymentStatus;
    if (d.status === 'QUEUED') {
      const r = await tx.deployment.updateMany({
        where: { id: d.id, status: 'QUEUED' },
        data: { status: 'CANCELED', progress: 100, cancelRequestedAt: now, finishedAt: now },
      });
      if (r.count !== 1) throw new AppError('conflict', 'Deployment state changed; try again');
      next = 'CANCELED';
    } else {
      const r = await tx.deployment.updateMany({
        where: { id: d.id, status: { in: ['CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING'] } },
        data: { status: 'CANCELING', cancelRequestedAt: now },
      });
      if (r.count !== 1) throw new AppError('conflict', 'Deployment state changed; try again');
      next = 'CANCELING';
    }
    const max = await tx.deploymentLog.aggregate({ where: { deploymentId: d.id }, _max: { seq: true } });
    await tx.deploymentLog.create({
      data: { deploymentId: d.id, seq: (max._max.seq ?? 0) + 1000, level: 'WARN', stream: 'SYSTEM', message: 'Cancellation requested' },
    });
    await audit(tx, { orgId: d.project.orgId, actorId, action: 'deployment.cancel', targetType: 'deployment', targetId: d.id });
    return next;
  });
}

/**
 * Promote a READY production deployment to be the project's active one (the thing the project's
 * production hostname and verified custom domains serve).
 *  - `force` is used by rollback to go to an OLDER deployment.
 *  - without `force`, an older build that finishes late must not replace a newer active one.
 */
export async function activateDeployment(
  deploymentId: string,
  opts: { force?: boolean; actorId?: string | null } = {},
): Promise<{ activated: boolean; reason?: string }> {
  return prisma.$transaction(async (tx) => {
    const d = await tx.deployment.findUnique({ where: { id: deploymentId }, include: { project: { include: { activeDeployment: true } } } });
    if (!d) return { activated: false, reason: 'not_found' };
    if (d.status !== 'READY' && d.status !== 'DEPLOYING') return { activated: false, reason: 'not_ready' };
    if (d.environment !== 'PRODUCTION') return { activated: false, reason: 'not_production' };
    if (d.project.state !== 'ACTIVE') return { activated: false, reason: 'project_deleting' };
    const current = d.project.activeDeployment;
    if (!opts.force && current && current.id !== d.id && current.createdAt > d.createdAt) {
      return { activated: false, reason: 'superseded' };
    }
    await tx.project.update({ where: { id: d.projectId }, data: { activeDeploymentId: d.id } });
    await audit(tx, {
      orgId: d.project.orgId,
      actorId: opts.actorId,
      action: opts.force ? 'deployment.rollback' : 'deployment.promote',
      targetType: 'deployment',
      targetId: d.id,
      metadata: { previous: current?.id ?? null },
    });
    return { activated: true };
  });
}

/**
 * Rollback = re-activate a previously successful, immutable production deployment.
 * Static artifacts switch instantly (single transaction). Python deployments need their runtime
 * running first, so the switch is delegated to the worker via the outbox.
 */
export async function rollbackTo(deploymentId: string, actorId: string | null) {
  const d = await prisma.deployment.findUnique({ where: { id: deploymentId }, include: { project: true } });
  if (!d) throw new AppError('not_found', 'Deployment not found');
  if (d.status !== 'READY' || d.environment !== 'PRODUCTION') {
    throw new AppError('conflict', 'Only successful production deployments can be rolled back to.');
  }
  if (d.project.activeDeploymentId === d.id) throw new AppError('conflict', 'This deployment is already active.');
  if (!d.artifactPrefix) throw new AppError('conflict', 'Deployment has no stored artifact.');
  if (d.runtime === 'STATIC') {
    const r = await activateDeployment(d.id, { force: true, actorId });
    return { mode: 'immediate' as const, ...r };
  }
  await prisma.$transaction(async (tx) => {
    await tx.outboxEvent.create({
      data: { type: OUTBOX_TYPES.deploymentActivate, aggregateId: d.id, payload: { deploymentId: d.id, requestedByUserId: actorId } },
    });
    await audit(tx, { orgId: d.project.orgId, actorId, action: 'deployment.rollback.requested', targetType: 'deployment', targetId: d.id });
  });
  return { mode: 'async' as const, activated: false };
}

/**
 * Final step of a build: in ONE transaction move DEPLOYING -> READY and (for production deployments
 * that are not superseded by a newer one) point the project at it. Because routing reads
 * Project.activeDeploymentId, "READY" and "routable" become true atomically - a deployment can never be
 * READY-but-unrouted or routed-but-not-READY.
 * Returns false if the deployment left DEPLOYING first (e.g. canceled).
 */
export async function markReadyAndActivate(deploymentId: string): Promise<{ ok: boolean; activated: boolean }> {
  return prisma.$transaction(async (tx) => {
    const now = new Date();
    const r = await tx.deployment.updateMany({
      where: { id: deploymentId, status: 'DEPLOYING' },
      data: { status: 'READY', progress: 100, readyAt: now, finishedAt: now },
    });
    if (r.count !== 1) return { ok: false, activated: false };
    const d = await tx.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { project: { include: { activeDeployment: true } } } });
    let activated = false;
    if (d.environment === 'PRODUCTION' && d.project.state === 'ACTIVE') {
      const cur = d.project.activeDeployment;
      if (!cur || cur.id === d.id || cur.createdAt <= d.createdAt) {
        await tx.project.update({ where: { id: d.projectId }, data: { activeDeploymentId: d.id } });
        activated = true;
      }
    }
    await tx.usageRecord.upsert({
      where: { deploymentId_metric: { deploymentId, metric: 'ARTIFACT_BYTES' } },
      update: {},
      create: { orgId: d.project.orgId, projectId: d.projectId, deploymentId, metric: 'ARTIFACT_BYTES', quantity: d.artifactBytes ?? 0n },
    });
    return { ok: true, activated };
  });
}
