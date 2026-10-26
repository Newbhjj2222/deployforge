import { AppError, productionHostname, validateRelativeDir, slugify, validateSlug } from '@deployforge/core';
import { Prisma, audit, prisma, requireOrgRole } from '@deployforge/db';
import { api, parseBody, parseQuery, serialize } from '@/lib/api';
import { config } from '@/lib/env';
import { CreateProject, Pagination } from '@/lib/schemas';
import { projectDto } from '@/lib/serialize';

export const GET = api(async ({ req, userId }) => {
  const q = parseQuery(req, Pagination);
  const rows = await prisma.project.findMany({
    where: {
      state: 'ACTIVE',
      org: { members: { some: { userId } } },
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { slug: { contains: q.q, mode: 'insensitive' } }] } : {}),
    },
    include: {
      connection: true,
      activeDeployment: { select: { id: true, status: true, commitSha: true, readyAt: true } },
      deployments: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, status: true, createdAt: true } },
    },
    orderBy: { createdAt: 'desc' },
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, q.limit);
  return serialize({
    projects: page.map((p) => ({ ...projectDto(p), latestDeployment: p.deployments[0] ?? null, activeDeployment: p.activeDeployment })),
    nextCursor: rows.length > q.limit ? page[page.length - 1]!.id : null,
  });
});

export const POST = api(async ({ req, userId, ip }) => {
  const body = await parseBody(req, CreateProject);
  const cfg = config();

  // organisation: default to the user's personal org; creating requires MEMBER or above
  const membership = body.orgId
    ? { orgId: body.orgId }
    : await prisma.organizationMember.findFirst({ where: { userId, org: { personal: true } }, select: { orgId: true } });
  if (!membership) throw new AppError('bad_request', 'No organization available');
  await requireOrgRole(userId, membership.orgId, 'MEMBER');
  const orgId = membership.orgId;

  const count = await prisma.project.count({ where: { orgId, state: 'ACTIVE' } });
  if (count >= cfg.LIMIT_PROJECTS_PER_ORG) throw new AppError('quota_exceeded', `Project limit reached (${cfg.LIMIT_PROJECTS_PER_ORG}).`);

  // the installation must belong to the same organisation (prevents attaching someone else's repos)
  const installation = await prisma.gitHubInstallation.findFirst({ where: { id: body.installationId, orgId, status: 'ACTIVE' } });
  if (!installation) throw new AppError('not_found', 'GitHub installation not found');
  const { listRepos } = await import('@/lib/git-provider');
  const repo = (await listRepos(installation)).find((r) => r.fullName === body.repository);
  if (!repo) throw new AppError('forbidden', 'This repository is not accessible to the installation.');

  const rootDirectory = validateRelativeDir(body.rootDirectory ?? '');
  const slug = body.slug ?? slugify(body.name);
  const v = validateSlug(slug);
  if (!v.ok) throw new AppError('validation_failed', v.reason);
  const s = body.settings;
  const isPython = s.framework === 'FASTAPI' || s.framework === 'FLASK';
  if (isPython && !s.startCommand) throw new AppError('validation_failed', 'A start command is required for Python applications.');
  if (s.framework === 'NEXTJS' && !s.outputDirectory) throw new AppError('validation_failed', 'Next.js projects need an output directory (static export).');

  try {
    const project = await prisma.$transaction(async (tx) => {
      const p = await tx.project.create({
        data: {
          orgId,
          name: body.name,
          slug,
          framework: s.framework,
          runtime: isPython ? 'PYTHON' : 'STATIC',
          productionBranch: body.productionBranch ?? repo.defaultBranch,
          installCommand: s.installCommand ?? null,
          buildCommand: s.buildCommand ?? null,
          outputDirectory: isPython ? null : (s.outputDirectory ?? null),
          startCommand: isPython ? s.startCommand! : null,
          pythonVersion: isPython ? (s.pythonVersion ?? '3.12') : null,
          nodeVersion: s.nodeVersion ?? '22',
          port: s.port ?? 8000,
          healthCheckPath: s.healthCheckPath ?? '/health',
          spaFallback: s.spaFallback ?? false,
          connection: {
            create: { orgId, installationRef: installation.id, githubRepoId: BigInt(repo.id), fullName: repo.fullName, defaultBranch: repo.defaultBranch, isPrivate: repo.private, rootDirectory },
          },
        },
        include: { connection: true },
      });
      await audit(tx, { orgId, actorId: userId, action: 'project.create', targetType: 'project', targetId: p.id, metadata: { slug, repo: repo.fullName }, ip });
      return p;
    });
    return serialize({ project: projectDto(project), url: `${cfg.PUBLIC_SCHEME}://${productionHostname(slug, cfg.ROOT_DOMAIN)}${cfg.PUBLIC_PORT_SUFFIX}` });
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
      const target = String((e.meta as { target?: unknown })?.target ?? '');
      throw new AppError('conflict', target.includes('slug') ? 'This project name is taken. Choose another.' : 'This repository is already connected to a project in your organization.');
    }
    throw e;
  }
});
