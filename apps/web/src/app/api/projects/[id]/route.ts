import { AppError, OUTBOX_TYPES, validateRelativeDir } from '@deployforge/core';
import { audit, prisma, requireProject } from '@deployforge/db';
import { api, parseBody, serialize } from '@/lib/api';
import { UpdateProject } from '@/lib/schemas';
import { deploymentDto, projectDto } from '@/lib/serialize';

type P = { id: string };

export const GET = api<P>(async ({ userId, params }) => {
  const { project, role } = await requireProject(userId, params.id);
  const active = project.activeDeploymentId ? await prisma.deployment.findUnique({ where: { id: project.activeDeploymentId } }) : null;
  return serialize({ project: projectDto(project), role, activeDeployment: active ? deploymentDto(active) : null });
});

export const PATCH = api<P>(async ({ req, userId, params, ip }) => {
  const { project } = await requireProject(userId, params.id, 'ADMIN');
  const body = await parseBody(req, UpdateProject);
  const isPython = (body.framework ?? project.framework) === 'FASTAPI' || (body.framework ?? project.framework) === 'FLASK';
  if (body.outputDirectory) validateRelativeDir(body.outputDirectory);
  if (isPython && body.startCommand === null) throw new AppError('validation_failed', 'A start command is required for Python applications.');
  const updated = await prisma.$transaction(async (tx) => {
    const p = await tx.project.update({
      where: { id: project.id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.productionBranch !== undefined && { productionBranch: body.productionBranch }),
        ...(body.previewDeployments !== undefined && { previewDeployments: body.previewDeployments }),
        ...(body.framework !== undefined && { framework: body.framework, runtime: isPython ? 'PYTHON' : 'STATIC' }),
        ...(body.installCommand !== undefined && { installCommand: body.installCommand }),
        ...(body.buildCommand !== undefined && { buildCommand: body.buildCommand }),
        ...(body.outputDirectory !== undefined && { outputDirectory: body.outputDirectory }),
        ...(body.startCommand !== undefined && { startCommand: body.startCommand }),
        ...(body.pythonVersion !== undefined && { pythonVersion: body.pythonVersion }),
        ...(body.nodeVersion !== undefined && { nodeVersion: body.nodeVersion }),
        ...(body.port !== undefined && { port: body.port }),
        ...(body.healthCheckPath !== undefined && { healthCheckPath: body.healthCheckPath }),
        ...(body.spaFallback !== undefined && { spaFallback: body.spaFallback }),
      },
      include: { connection: true },
    });
    await audit(tx, { orgId: p.orgId, actorId: userId, action: 'project.update', targetType: 'project', targetId: p.id, metadata: { fields: Object.keys(body) }, ip });
    return p;
  });
  // settings changes apply to FUTURE deployments only: existing ones keep their immutable snapshot
  return serialize({ project: projectDto(updated) });
});

/**
 * Deletion is two-phase: mark DELETING (immediately hides the project and stops routing), then the worker
 * removes artifacts + runtimes and only then hard-deletes the row (outbox event => retried until it works).
 */
export const DELETE = api<P>(async ({ userId, params, ip }) => {
  const { project } = await requireProject(userId, params.id, 'OWNER');
  await prisma.$transaction(async (tx) => {
    await tx.project.update({ where: { id: project.id }, data: { state: 'DELETING', activeDeploymentId: null } });
    await tx.outboxEvent.create({ data: { type: OUTBOX_TYPES.projectCleanup, aggregateId: project.id, payload: { projectId: project.id } } });
    await audit(tx, { orgId: project.orgId, actorId: userId, action: 'project.delete', targetType: 'project', targetId: project.id, metadata: { slug: project.slug }, ip });
  });
  return { ok: true };
});
