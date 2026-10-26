import { randomUUID } from 'node:crypto';
import { AppError } from '@deployforge/core';
import { createDeployment, prisma, requireProject } from '@deployforge/db';
import { api, parseBody, parseQuery, serialize } from '@/lib/api';
import { config } from '@/lib/env';
import { resolveCommit } from '@/lib/git-provider';
import { CreateDeployment, Pagination } from '@/lib/schemas';
import { deploymentDto } from '@/lib/serialize';

type P = { id: string };

export const GET = api<P>(async ({ req, userId, params }) => {
  await requireProject(userId, params.id);
  const q = parseQuery(req, Pagination);
  const statuses = q.status ? q.status.split(',').filter((s) => /^[A-Z]+$/.test(s)) : [];
  const rows = await prisma.deployment.findMany({
    where: { projectId: params.id, ...(statuses.length ? { status: { in: statuses as never[] } } : {}), ...(q.q ? { OR: [{ commitSha: { startsWith: q.q.toLowerCase() } }, { branch: { contains: q.q, mode: 'insensitive' } }, { commitMessage: { contains: q.q, mode: 'insensitive' } }] } : {}) },
    orderBy: { createdAt: 'desc' },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, q.limit);
  return serialize({ deployments: page.map(deploymentDto), nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null });
});

/** Manual deployment: resolve the branch/ref to an immutable commit SHA server-side, then enqueue via the outbox. */
export const POST = api<P>(
  async ({ req, userId, params }) => {
    const { project } = await requireProject(userId, params.id, 'MEMBER');
    const body = await parseBody(req, CreateDeployment);
    const cfg = config();
    if (!project.connection || project.connection.disabledAt) throw new AppError('conflict', 'The repository connection is not active. Reconnect GitHub.');
    const inst = await prisma.gitHubInstallation.findUniqueOrThrow({ where: { id: project.connection.installationRef } });
    if (inst.status !== 'ACTIVE') throw new AppError('conflict', 'The GitHub installation is not active.');
    const branch = body.branch ?? project.productionBranch;
    const commit = await resolveCommit(inst, project.connection.fullName, body.ref ?? branch);
    const environment = body.environment ?? (branch === project.productionBranch ? 'PRODUCTION' : 'PREVIEW');
    if (environment === 'PREVIEW' && !project.previewDeployments) throw new AppError('conflict', 'Preview deployments are disabled for this project.');
    // A fresh key per click; double-submits within the same second of the same SHA are collapsed by the client disabling the button
    // and by the per-day quota. Webhook deliveries use a deterministic key (delivery id) instead.
    const { deployment, created } = await createDeployment({
      projectId: project.id,
      environment,
      trigger: 'MANUAL',
      branch,
      commitSha: commit.sha,
      commitMessage: commit.message,
      commitAuthor: commit.author,
      createdById: userId,
      idempotencyKey: `manual:${randomUUID()}`,
      rootDomain: cfg.ROOT_DOMAIN,
      maxPerDay: cfg.LIMIT_DEPLOYMENTS_PER_PROJECT_PER_DAY,
    });
    return serialize({ deployment: deploymentDto(deployment), created });
  },
  { bucket: 'deploy', limit: 20, windowSec: 60 },
);
