import { z } from 'zod';
import { addDomain, prisma, requireProject } from '@deployforge/db';
import { api, parseBody, serialize } from '@/lib/api';
import { config } from '@/lib/env';
import { domainDto } from '@/lib/serialize';

type P = { id: string };

export const GET = api<P>(async ({ userId, params }) => {
  await requireProject(userId, params.id);
  const domains = await prisma.domain.findMany({ where: { projectId: params.id }, orderBy: { createdAt: 'asc' } });
  return serialize({ domains: domains.map(domainDto) });
});

export const POST = api<P>(
  async ({ req, userId, params }) => {
    const { project } = await requireProject(userId, params.id, 'ADMIN');
    const { hostname } = await parseBody(req, z.object({ hostname: z.string().trim().min(3).max(260) }));
    const cfg = config();
    const d = await addDomain({ projectId: project.id, orgId: project.orgId, actorId: userId, hostname, rootDomain: cfg.ROOT_DOMAIN, maxPerProject: cfg.LIMIT_DOMAINS_PER_PROJECT });
    return serialize({ domain: domainDto(d) });
  },
  { bucket: 'domain-add', limit: 20, windowSec: 600 },
);
