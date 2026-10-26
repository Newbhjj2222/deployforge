import { z } from 'zod';
import { AppError } from '@deployforge/core';
import { prisma } from '@deployforge/db';
import { api, parseQuery } from '@/lib/api';
import { listRepos } from '@/lib/git-provider';

export const GET = api(async ({ req, userId }) => {
  const { installationId } = parseQuery(req, z.object({ installationId: z.string().min(1) }));
  // authorisation: the installation must belong to an organisation the caller is a member of
  const inst = await prisma.gitHubInstallation.findFirst({ where: { id: installationId, status: 'ACTIVE', org: { members: { some: { userId } } } } });
  if (!inst) throw new AppError('not_found', 'Installation not found');
  const repos = await listRepos(inst);
  const connected = await prisma.repositoryConnection.findMany({ where: { installationRef: inst.id, project: { state: 'ACTIVE' } }, select: { fullName: true, project: { select: { id: true, slug: true } } } });
  const byName = new Map(connected.map((c) => [c.fullName, c.project]));
  return { repositories: repos.map((r) => ({ ...r, project: byName.get(r.fullName) ?? null })) };
});
