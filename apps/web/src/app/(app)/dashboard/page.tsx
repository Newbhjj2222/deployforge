import Link from 'next/link';
import { prisma } from '@deployforge/db';
import { auth } from '@/auth';
import { Card, CardHeader, Empty, StatusBadge } from '@/components/ui';
import { timeAgo } from '@/lib/client';

export const metadata = { title: 'Overview' };
export const dynamic = 'force-dynamic';

export default async function Dashboard() {
  const session = await auth();
  const userId = session!.user.id;
  const scope = { project: { state: 'ACTIVE' as const, org: { members: { some: { userId } } } } };
  const since = new Date(Date.now() - 7 * 24 * 3600_000);
  const [projects, recent, total, ready, failed, live] = await Promise.all([
    prisma.project.count({ where: { state: 'ACTIVE', org: { members: { some: { userId } } } } }),
    prisma.deployment.findMany({ where: scope, orderBy: { createdAt: 'desc' }, take: 8, include: { project: { select: { name: true, slug: true } } } }),
    prisma.deployment.count({ where: { ...scope, createdAt: { gte: since } } }),
    prisma.deployment.count({ where: { ...scope, status: 'READY', createdAt: { gte: since } } }),
    prisma.deployment.count({ where: { ...scope, status: 'FAILED', createdAt: { gte: since } } }),
    prisma.deployment.count({ where: { ...scope, status: { in: ['QUEUED', 'CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING'] } } }),
  ]);
  const stats = [
    ['Projects', projects],
    ['Deployments (7d)', total],
    ['Succeeded (7d)', ready],
    ['Failed (7d)', failed],
    ['In progress', live],
  ] as const;
  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
        <Link href="/projects/new" className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg hover:brightness-110">New project</Link>
      </div>
      <dl className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stats.map(([k, v]) => (
          <div key={k} className="rounded-lg border border-line bg-panel p-4">
            <dt className="text-xs text-muted">{k}</dt>
            <dd className="mt-1 text-2xl font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <Card>
        <CardHeader title="Recent deployments" />
        {recent.length === 0 ? (
          <Empty title="No deployments yet" desc="Import a repository to create your first deployment." action={<Link href="/projects/new" className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg">Import a repository</Link>} />
        ) : (
          <ul className="divide-y divide-line">
            {recent.map((d) => (
              <li key={d.id}>
                <Link href={`/deployments/${d.id}`} className="flex items-center gap-4 px-5 py-3 hover:bg-panel-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{d.project.name} <span className="font-mono text-xs text-muted">{d.commitSha.slice(0, 7)}</span></p>
                    <p className="truncate text-xs text-muted">{d.commitMessage ?? d.branch} · {d.branch} · {timeAgo(d.createdAt)}</p>
                  </div>
                  <StatusBadge status={d.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
