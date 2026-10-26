import { z } from 'zod';
import { AppError } from '@deployforge/core';
import { prisma } from '@deployforge/db';
import { api, parseBody } from '@/lib/api';
import { detect, listRepos } from '@/lib/git-provider';

const Body = z.object({
  installationId: z.string().min(1),
  repository: z.string().min(3).max(201),
  branch: z.string().regex(/^[A-Za-z0-9._\-/]{1,200}$/).optional(),
  rootDirectory: z.string().max(200).optional(),
});

/** Suggest build settings from repository files. A suggestion only: the user confirms before anything runs. */
export const POST = api(
  async ({ req, userId }) => {
    const b = await parseBody(req, Body);
    const inst = await prisma.gitHubInstallation.findFirst({ where: { id: b.installationId, status: 'ACTIVE', org: { members: { some: { userId } } } } });
    if (!inst) throw new AppError('not_found', 'Installation not found');
    const repo = (await listRepos(inst)).find((r) => r.fullName === b.repository);
    if (!repo) throw new AppError('not_found', 'Repository not found');
    return { repository: repo.fullName, branch: b.branch ?? repo.defaultBranch, detection: await detect(inst, repo.fullName, b.branch ?? repo.defaultBranch, b.rootDirectory ?? '') };
  },
  { bucket: 'gh-detect', limit: 30, windowSec: 60 },
);
