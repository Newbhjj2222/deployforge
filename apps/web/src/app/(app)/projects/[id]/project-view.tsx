'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Mono, OkNote, Select, Spinner, StatusBadge } from '@/components/ui';
import { call, timeAgo } from '@/lib/client';
import { cn } from '@/lib/cn';

interface Project {
  id: string; name: string; slug: string; framework: string; runtime: string; productionBranch: string; installCommand: string | null;
  buildCommand: string | null; outputDirectory: string | null; startCommand: string | null; port: number; healthCheckPath: string;
  spaFallback: boolean; previewDeployments: boolean; productionUrl: string; activeDeploymentId: string | null;
  repository: { fullName: string; rootDirectory: string; disabled: boolean } | null;
}
interface Dep {
  id: string; status: string; environment: string; branch: string; commitSha: string; commitMessage: string | null; createdAt: string;
  url: string | null; failureReason: string | null; trigger: string;
}

const TABS = ['Deployments', 'Settings', 'Environment', 'Domains'] as const;

export function ProjectView({ id }: { id: string }) {
  const [p, setP] = useState<{ project: Project; role: string } | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number]>('Deployments');
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => call<{ project: Project; role: string }>(`/api/projects/${id}`).then(setP).catch((e) => setError(e.message)), [id]);
  useEffect(() => void reload(), [reload]);
  if (!p) return <div className="flex justify-center p-12">{error ? <ErrorNote error={error} /> : <Spinner />}</div>;
  const { project, role } = p;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-1 text-sm text-muted">{project.repository?.fullName} · {project.framework.toLowerCase()} · <a className="text-accent underline" href={project.productionUrl} target="_blank" rel="noreferrer">{project.productionUrl.replace(/^https?:\/\//, '')}</a></p>
        </div>
      </div>
      {project.repository?.disabled && <ErrorNote error="The GitHub installation for this project was removed or suspended. Reconnect it under GitHub to deploy again." />}
      <div role="tablist" className="flex gap-1 border-b border-line">
        {TABS.map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('-mb-px border-b-2 px-4 py-2 text-sm', tab === t ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg')}>{t}</button>
        ))}
      </div>
      {tab === 'Deployments' && <Deployments project={project} onChange={reload} />}
      {tab === 'Settings' && <Settings project={project} role={role} onSaved={reload} />}
      {tab === 'Environment' && <EnvVars projectId={id} canEdit={role !== 'MEMBER' && role !== 'VIEWER'} />}
      {tab === 'Domains' && <Domains projectId={id} canEdit={role !== 'MEMBER' && role !== 'VIEWER'} />}
    </div>
  );
}

function Deployments({ project, onChange }: { project: Project; onChange: () => void }) {
  const router = useRouter();
  const [rows, setRows] = useState<Dep[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (reset: boolean, after?: string | null) => {
    setLoading(true);
    try {
      const sp = new URLSearchParams({ limit: '15' });
      if (status) sp.set('status', status);
      if (q) sp.set('q', q);
      if (after) sp.set('cursor', after);
      const r = await call<{ deployments: Dep[]; nextCursor: string | null }>(`/api/projects/${project.id}/deployments?${sp}`);
      setRows((prev) => (reset ? r.deployments : [...prev, ...r.deployments]));
      setCursor(r.nextCursor);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  }, [project.id, status, q]);
  useEffect(() => {
    const t = setTimeout(() => void load(true), 200);
    const poll = setInterval(() => void load(true), 5000); // keeps status badges live
    return () => { clearTimeout(t); clearInterval(poll); };
  }, [load]);

  async function deploy() {
    setBusy('deploy');
    setError(null);
    try {
      const r = await call<{ deployment: { id: string } }>(`/api/projects/${project.id}/deployments`, { method: 'POST', body: {} });
      router.push(`/deployments/${r.deployment.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
      setBusy(null);
    }
  }
  async function rollback(id: string) {
    setBusy(id);
    setError(null);
    try {
      await call(`/api/deployments/${id}/rollback`, { method: 'POST' });
      onChange();
      await load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Rollback failed');
    } finally {
      setBusy(null);
    }
  }
  return (
    <Card>
      <CardHeader
        title="Deployment history"
        action={
          <div className="flex flex-wrap gap-2">
            <Input aria-label="Search deployments" placeholder="Branch, sha, message…" value={q} onChange={(e) => setQ(e.target.value)} className="w-48" />
            <Select aria-label="Filter by status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
              <option value="">All statuses</option>
              {['READY', 'FAILED', 'QUEUED,CLONING,INSTALLING,BUILDING,UPLOADING,DEPLOYING', 'CANCELED'].map((s) => <option key={s} value={s}>{s.startsWith('QUEUED') ? 'IN PROGRESS' : s}</option>)}
            </Select>
            <Button disabled={busy === 'deploy' || project.repository?.disabled} onClick={() => void deploy()}>{busy === 'deploy' ? 'Starting…' : 'Deploy'}</Button>
          </div>
        }
      />
      {error && <div className="p-4"><ErrorNote error={error} /></div>}
      {loading && rows.length === 0 ? <div className="flex justify-center p-10"><Spinner /></div> : rows.length === 0 ? (
        <Empty title="No deployments" desc={q || status ? 'Nothing matches the filters.' : 'Click Deploy to build the production branch.'} />
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
              <Link href={`/deployments/${d.id}`} className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium"><Mono>{d.commitSha.slice(0, 7)}</Mono> {d.commitMessage ?? d.branch} {project.activeDeploymentId === d.id && <span className="ml-1 rounded bg-accent/15 px-1.5 text-xs text-accent">live</span>}</p>
                <p className="truncate text-xs text-muted">{d.environment.toLowerCase()} · {d.branch} · {d.trigger.toLowerCase()} · {timeAgo(d.createdAt)}{d.failureReason ? ` · ${d.failureReason}` : ''}</p>
              </Link>
              {d.url && <a href={d.url} target="_blank" rel="noreferrer" className="text-xs text-accent underline">Visit</a>}
              {d.status === 'READY' && d.environment === 'PRODUCTION' && project.activeDeploymentId !== d.id && (
                <Button variant="outline" disabled={busy === d.id} onClick={() => void rollback(d.id)}>{busy === d.id ? '…' : 'Promote / roll back'}</Button>
              )}
              <StatusBadge status={d.status} />
            </li>
          ))}
        </ul>
      )}
      {cursor && <div className="flex justify-center border-t border-line p-3"><Button variant="ghost" onClick={() => void load(false, cursor)}>Load more</Button></div>}
    </Card>
  );
}

function Settings({ project, role, onSaved }: { project: Project; role: string; onSaved: () => void }) {
  const router = useRouter();
  const canEdit = role === 'OWNER' || role === 'ADMIN';
  const [f, setF] = useState({ name: project.name, productionBranch: project.productionBranch, installCommand: project.installCommand ?? '', buildCommand: project.buildCommand ?? '', outputDirectory: project.outputDirectory ?? '', startCommand: project.startCommand ?? '', port: String(project.port), healthCheckPath: project.healthCheckPath, spaFallback: project.spaFallback, previewDeployments: project.previewDeployments });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const py = project.runtime === 'PYTHON';
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Build & deployment" desc="Changes apply to new deployments. Existing deployments keep the settings they were built with." />
        <form className="space-y-4 p-5" onSubmit={async (e) => {
          e.preventDefault();
          setError(null); setMsg(null);
          try {
            await call(`/api/projects/${project.id}`, { method: 'PATCH', body: { name: f.name, productionBranch: f.productionBranch, installCommand: f.installCommand || null, buildCommand: f.buildCommand || null, ...(py ? { startCommand: f.startCommand || null, port: Number(f.port), healthCheckPath: f.healthCheckPath } : { outputDirectory: f.outputDirectory || null }), spaFallback: f.spaFallback, previewDeployments: f.previewDeployments } });
            setMsg('Saved.');
            onSaved();
          } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
        }}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name" htmlFor="s-name"><Input id="s-name" value={f.name} onChange={set('name')} disabled={!canEdit} /></Field>
            <Field label="Production branch" htmlFor="s-br"><Input id="s-br" value={f.productionBranch} onChange={set('productionBranch')} disabled={!canEdit} /></Field>
            <Field label="Install command" htmlFor="s-ic"><Input id="s-ic" className="font-mono" value={f.installCommand} onChange={set('installCommand')} disabled={!canEdit} /></Field>
            <Field label="Build command" htmlFor="s-bc"><Input id="s-bc" className="font-mono" value={f.buildCommand} onChange={set('buildCommand')} disabled={!canEdit} /></Field>
            {!py ? <Field label="Output directory" htmlFor="s-od"><Input id="s-od" className="font-mono" value={f.outputDirectory} onChange={set('outputDirectory')} disabled={!canEdit} /></Field> : (
              <>
                <Field label="Start command" htmlFor="s-sc"><Input id="s-sc" className="font-mono" value={f.startCommand} onChange={set('startCommand')} disabled={!canEdit} /></Field>
                <Field label="Port" htmlFor="s-port"><Input id="s-port" type="number" value={f.port} onChange={set('port')} disabled={!canEdit} /></Field>
                <Field label="Health check path" htmlFor="s-hc"><Input id="s-hc" value={f.healthCheckPath} onChange={set('healthCheckPath')} disabled={!canEdit} /></Field>
              </>
            )}
          </div>
          {!py && <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={f.spaFallback} onChange={(e) => setF((x) => ({ ...x, spaFallback: e.target.checked }))} /> Single-page app fallback</label>}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!canEdit} checked={f.previewDeployments} onChange={(e) => setF((x) => ({ ...x, previewDeployments: e.target.checked }))} /> Create preview deployments for non-production branches</label>
          <ErrorNote error={error} /><OkNote msg={msg} />
          {canEdit && <Button>Save changes</Button>}
        </form>
      </Card>
      {role === 'OWNER' && (
        <Card className="border-danger/40">
          <CardHeader title="Delete project" desc="Removes the project, all deployments, artifacts and domains. This cannot be undone." />
          <div className="flex flex-wrap items-end gap-3 p-5">
            <Field label={`Type "${project.slug}" to confirm`} htmlFor="del"><Input id="del" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            <Button variant="danger" disabled={confirm !== project.slug} onClick={async () => {
              try { await call(`/api/projects/${project.id}`, { method: 'DELETE' }); router.push('/projects'); } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
            }}>Delete project</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

interface EnvVar { id: string; key: string; environment: string; scope: string; value: string; updatedAt: string }

function EnvVars({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [f, setF] = useState({ key: '', value: '', environment: 'PRODUCTION', scope: 'BUILD_AND_RUNTIME' });
  const [rotating, setRotating] = useState<string | null>(null);
  const [newValue, setNewValue] = useState('');
  const load = useCallback(() => call<{ variables: EnvVar[] }>(`/api/projects/${projectId}/env`).then((r) => setVars(r.variables)).catch((e) => setError(e.message)), [projectId]);
  useEffect(() => void load(), [load]);
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader title="Environment variables" desc="Values are encrypted at rest and never shown again after saving. Build-scope variables are available to install/build steps; runtime-scope variables are passed to running Python apps." />
        <ErrorNote error={error} /><OkNote msg={msg} />
        {!vars ? <div className="flex justify-center p-8"><Spinner /></div> : vars.length === 0 ? <Empty title="No variables" desc="Add API keys and configuration your app needs." /> : (
          <ul className="divide-y divide-line">
            {vars.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center gap-3 px-5 py-3">
                <Mono className="text-sm">{v.key}</Mono>
                <span className="font-mono text-xs text-muted">{v.value}</span>
                <span className="text-xs text-muted">{v.environment.toLowerCase()} · {v.scope.replaceAll('_', ' ').toLowerCase()}</span>
                <span className="ml-auto flex gap-2">
                  {canEdit && (rotating === v.id ? (
                    <>
                      <Input aria-label={`New value for ${v.key}`} type="password" autoComplete="off" value={newValue} onChange={(e) => setNewValue(e.target.value)} className="w-48" />
                      <Button disabled={!newValue} onClick={async () => { try { await call(`/api/projects/${projectId}/env/${v.key}`, { method: 'PATCH', body: { value: newValue, environment: v.environment } }); setRotating(null); setNewValue(''); setMsg(`${v.key} updated. Redeploy to apply.`); void load(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); } }}>Save</Button>
                      <Button variant="ghost" onClick={() => { setRotating(null); setNewValue(''); }}>Cancel</Button>
                    </>
                  ) : (
                    <>
                      <Button variant="outline" onClick={() => setRotating(v.id)}>Replace value</Button>
                      <Button variant="danger" onClick={async () => { if (!confirm(`Delete ${v.key}?`)) return; try { await call(`/api/projects/${projectId}/env/${v.key}?environment=${v.environment}`, { method: 'DELETE' }); void load(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); } }}>Delete</Button>
                    </>
                  ))}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {canEdit && (
        <Card>
          <CardHeader title="Add variable" />
          <form className="grid gap-4 p-5 sm:grid-cols-2" onSubmit={async (e) => {
            e.preventDefault(); setError(null); setMsg(null);
            try { await call(`/api/projects/${projectId}/env`, { method: 'POST', body: f }); setF({ ...f, key: '', value: '' }); setMsg('Variable added. Redeploy to apply.'); void load(); } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
          }}>
            <Field label="Name" htmlFor="ev-k"><Input id="ev-k" className="font-mono" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} placeholder="DATABASE_URL" required /></Field>
            <Field label="Value" htmlFor="ev-v"><Input id="ev-v" type="password" autoComplete="off" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} required /></Field>
            <Field label="Environment" htmlFor="ev-e"><Select id="ev-e" value={f.environment} onChange={(e) => setF({ ...f, environment: e.target.value })}><option>PRODUCTION</option><option>PREVIEW</option></Select></Field>
            <Field label="Available to" htmlFor="ev-s"><Select id="ev-s" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value })}><option value="BUILD_AND_RUNTIME">Build and runtime</option><option value="BUILD">Build only</option><option value="RUNTIME">Runtime only</option></Select></Field>
            <div className="sm:col-span-2"><Button>Add variable</Button></div>
          </form>
        </Card>
      )}
    </div>
  );
}

interface Domain { id: string; hostname: string; status: string; tlsStatus: string; lastCheckedAt: string | null; dns: { txt: { type: string; name: string; value: string }; routing: { type: string; name: string; value: string; note?: string }[] } }

function Domains({ projectId, canEdit }: { projectId: string; canEdit: boolean }) {
  const [domains, setDomains] = useState<Domain[] | null>(null);
  const [host, setHost] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(() => call<{ domains: Domain[] }>(`/api/projects/${projectId}/domains`).then((r) => setDomains(r.domains)).catch((e) => setError(e.message)), [projectId]);
  useEffect(() => void load(), [load]);
  return (
    <div className="space-y-6">
      {canEdit && (
        <Card>
          <CardHeader title="Add a custom domain" desc="A domain only starts serving after you prove ownership with a DNS TXT record." />
          <form className="flex flex-wrap items-end gap-3 p-5" onSubmit={async (e) => {
            e.preventDefault(); setError(null); setMsg(null);
            try { await call(`/api/projects/${projectId}/domains`, { method: 'POST', body: { hostname: host } }); setHost(''); void load(); } catch (err) { setError(err instanceof Error ? err.message : 'Failed'); }
          }}>
            <Field label="Domain" htmlFor="dom"><Input id="dom" value={host} onChange={(e) => setHost(e.target.value)} placeholder="www.example.com" required className="w-72" /></Field>
            <Button>Add</Button>
          </form>
        </Card>
      )}
      <ErrorNote error={error} /><OkNote msg={msg} />
      <Card>
        <CardHeader title="Domains" />
        {!domains ? <div className="flex justify-center p-8"><Spinner /></div> : domains.length === 0 ? <Empty title="No custom domains" /> : (
          <ul className="divide-y divide-line">
            {domains.map((d) => (
              <li key={d.id} className="space-y-3 px-5 py-4">
                <div className="flex flex-wrap items-center gap-3">
                  <p className="font-medium">{d.hostname}</p>
                  <StatusBadge status={d.status} />
                  {d.status === 'ACTIVE' && <span className="text-xs text-muted">TLS: {d.tlsStatus.toLowerCase()}</span>}
                  <span className="ml-auto flex gap-2">
                    {canEdit && <Button variant="outline" disabled={busy === d.id} onClick={async () => { setBusy(d.id); setError(null); try { const r = await call<{ message: string }>(`/api/domains/${d.id}/verify`, { method: 'POST' }); setMsg(`${d.hostname}: ${r.message}`); await load(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); } finally { setBusy(null); } }}>{busy === d.id ? 'Checking…' : 'Verify'}</Button>}
                    {canEdit && <Button variant="danger" onClick={async () => { if (!confirm(`Remove ${d.hostname}?`)) return; try { await call(`/api/domains/${d.id}`, { method: 'DELETE' }); void load(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); } }}>Remove</Button>}
                  </span>
                </div>
                {d.status !== 'ACTIVE' && (
                  <div className="overflow-x-auto rounded-md border border-line text-xs">
                    <p className="border-b border-line bg-panel-2 px-3 py-2 text-muted">Add these DNS records at your DNS provider, then click Verify.</p>
                    <table className="w-full">
                      <thead><tr className="text-left text-muted"><th className="px-3 py-1.5">Type</th><th className="px-3 py-1.5">Name</th><th className="px-3 py-1.5">Value</th></tr></thead>
                      <tbody className="font-mono">
                        <tr><td className="px-3 py-1.5">{d.dns.txt.type}</td><td className="px-3 py-1.5 break-all">{d.dns.txt.name}</td><td className="px-3 py-1.5 break-all">{d.dns.txt.value}</td></tr>
                        {d.dns.routing.map((r, i) => <tr key={i}><td className="px-3 py-1.5">{r.type}</td><td className="px-3 py-1.5 break-all">{r.name}</td><td className="px-3 py-1.5 break-all">{r.value}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
