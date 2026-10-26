'use client';
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Empty, ErrorNote, Input, Spinner, StatusBadge } from '@/components/ui';
import { call, timeAgo } from '@/lib/client';

interface Row {
  id: string;
  name: string;
  slug: string;
  framework: string;
  productionUrl: string;
  repository: { fullName: string } | null;
  latestDeployment: { id: string; status: string; createdAt: string } | null;
  activeDeployment: { id: string; status: string; commitSha: string } | null;
}

export function ProjectList() {
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (reset: boolean, after?: string | null, query = q) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '12' });
      if (query) params.set('q', query);
      if (after) params.set('cursor', after);
      const r = await call<{ projects: Row[]; nextCursor: string | null }>(`/api/projects?${params}`);
      setRows((prev) => (reset ? r.projects : [...prev, ...r.projects]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  }, [q]);

  useEffect(() => {
    const t = setTimeout(() => void load(true, null, q), 250); // debounce search
    return () => clearTimeout(t);
  }, [q, load]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
        <div className="flex gap-3">
          <Input aria-label="Search projects" placeholder="Search projects…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
          <Link href="/projects/new" className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg hover:brightness-110">New project</Link>
        </div>
      </div>
      <ErrorNote error={error} />
      <Card>
        {loading && rows.length === 0 ? (
          <div className="flex justify-center p-12"><Spinner /></div>
        ) : rows.length === 0 ? (
          <Empty title={q ? 'No projects match your search' : 'No projects yet'} desc={q ? undefined : 'Connect GitHub and import a repository to deploy it.'} action={q ? undefined : <Link href="/projects/new" className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg">Import a repository</Link>} />
        ) : (
          <ul className="divide-y divide-line">
            {rows.map((p) => (
              <li key={p.id}>
                <Link href={`/projects/${p.id}`} className="flex items-center gap-4 px-5 py-4 hover:bg-panel-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{p.name}</p>
                    <p className="truncate text-xs text-muted">{p.repository?.fullName ?? 'no repository'} · {p.framework.toLowerCase()} · {p.slug}</p>
                  </div>
                  <div className="hidden text-right text-xs text-muted sm:block">
                    {p.activeDeployment ? <>live <span className="font-mono">{p.activeDeployment.commitSha.slice(0, 7)}</span></> : 'not deployed'}
                    <br />{timeAgo(p.latestDeployment?.createdAt)}
                  </div>
                  {p.latestDeployment && <StatusBadge status={p.latestDeployment.status} />}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {cursor && <div className="flex justify-center"><Button variant="outline" disabled={loading} onClick={() => void load(false, cursor)}>{loading ? 'Loading…' : 'Load more'}</Button></div>}
    </div>
  );
}
