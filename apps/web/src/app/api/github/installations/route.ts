import { prisma } from '@deployforge/db';
import { api, serialize } from '@/lib/api';
import { config, isDevLocalGit } from '@/lib/env';

export const GET = api(async ({ userId }) => {
  const c = config();
  const installations = await prisma.gitHubInstallation.findMany({
    where: { org: { members: { some: { userId } } } },
    include: { org: { select: { id: true, name: true, slug: true } }, _count: { select: { connections: true } } },
    orderBy: { createdAt: 'asc' },
  });
  const configured = Boolean(c.GITHUB_APP_ID && c.GITHUB_APP_PRIVATE_KEY && c.GITHUB_APP_SLUG);
  return serialize({
    installations: installations.map((i) => ({
      id: i.id,
      accountLogin: i.accountLogin,
      accountType: i.accountType,
      status: i.status,
      org: i.org,
      projects: i._count.connections,
      local: i.accountType === 'Local',
    })),
    github: {
      configured,
      installUrl: configured ? `https://github.com/apps/${c.GITHUB_APP_SLUG}/installations/new` : null,
      setupHelp: configured ? null : 'GitHub App is not configured. Set GITHUB_APP_ID, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET and GITHUB_WEBHOOK_SECRET (docs/github-app.md).',
    },
    devLocal: isDevLocalGit(),
  });
});
