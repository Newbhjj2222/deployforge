import type { OrgRole } from '@prisma/client';
import { AppError } from '@deployforge/core';
import { prisma } from './client';

const RANK: Record<OrgRole, number> = { VIEWER: 0, MEMBER: 1, ADMIN: 2, OWNER: 3 };

export const roleAtLeast = (role: OrgRole, min: OrgRole) => RANK[role] >= RANK[min];

/**
 * Resolve a project the user may access with at least `min` role.
 * Returns 404 (never 403) for projects in other organisations so ids cannot be enumerated.
 */
export async function requireProject(userId: string, projectId: string, min: OrgRole = 'VIEWER') {
  const project = await prisma.project.findFirst({
    where: { id: projectId, state: 'ACTIVE', org: { members: { some: { userId } } } },
    include: { org: { include: { members: { where: { userId }, select: { role: true } } } }, connection: true },
  });
  const role = project?.org.members[0]?.role;
  if (!project || !role) throw new AppError('not_found', 'Project not found');
  if (!roleAtLeast(role, min)) throw new AppError('forbidden', 'You do not have permission to do that');
  return { project, role };
}

export async function requireDeployment(userId: string, deploymentId: string, min: OrgRole = 'VIEWER') {
  const d = await prisma.deployment.findUnique({ where: { id: deploymentId }, select: { id: true, projectId: true } });
  if (!d) throw new AppError('not_found', 'Deployment not found');
  const { project, role } = await requireProject(userId, d.projectId, min);
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: d.id } });
  return { deployment, project, role };
}

export async function requireDomain(userId: string, domainId: string, min: OrgRole = 'ADMIN') {
  const dom = await prisma.domain.findUnique({ where: { id: domainId }, select: { id: true, projectId: true } });
  if (!dom) throw new AppError('not_found', 'Domain not found');
  const { project, role } = await requireProject(userId, dom.projectId, min);
  const domain = await prisma.domain.findUniqueOrThrow({ where: { id: dom.id } });
  return { domain, project, role };
}

export async function requireOrgRole(userId: string, orgId: string, min: OrgRole = 'VIEWER') {
  const m = await prisma.organizationMember.findUnique({ where: { orgId_userId: { orgId, userId } } });
  if (!m) throw new AppError('not_found', 'Organization not found');
  if (!roleAtLeast(m.role, min)) throw new AppError('forbidden', 'You do not have permission to do that');
  return m.role;
}
