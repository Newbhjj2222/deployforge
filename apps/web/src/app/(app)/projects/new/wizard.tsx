'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button, Card, CardHeader, Empty, ErrorNote, Field, Input, Select, Spinner } from '@/components/ui';
import { call } from '@/lib/client';

interface Installation { id: string; accountLogin: string; status: string; local: boolean }
interface Repo { id: string; fullName: string; private: boolean; defaultBranch: string; project: { id: string; slug: string } | null }
interface Detection {
  framework: string; label: string; runtime: string; installCommand: string | null; buildCommand: string | null;
  outputDirectory: string | null; startCommand: string | null; pythonVersion: string | null; port: number;
  healthCheckPath: string; supported: boolean; notes: string[]; sha: string;
}

const FRAMEWORKS = ['STATIC', 'VITE', 'REACT', 'NEXTJS', 'FASTAPI', 'FLASK', 'OTHER'];

export function NewProjectWizard() {
  const router = useRouter();
  const [installs, setInstalls] = useState<Installation[] | null>(null);
  const [installId, setInstallId] = useState('');
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [filter, setFilter] = useState('');
  const [repo, setRepo] = useState<Repo | null>(null);
  const [det, setDet] = useState<Detection | null>(null);
  const [form, setForm] = useState({ name: '', branch: '', rootDirectory: '', framework: 'STATIC', installCommand: '', buildCommand: '', outputDirectory: '', startCommand: '', pythonVersion: '3.12', port: '8000', healthCheckPath: '/health', spaFallback: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deployNow, setDeployNow] = useState(true);

  useEffect(() => {
    call<{ installations: Installation[] }>('/api/github/installations')
      .then((r) => {
        const ok = r.installations.filter((i) => i.status === 'ACTIVE');
        setInstalls(ok);
        if (ok[0]) setInstallId(ok[0].id);
      })
      .catch((e) => setError(e.message));
  }, []);

  useEffect(() => {
    if (!installId) return;
    setRepos(null);
    call<{ repositories: Repo[] }>(`/api/github/repositories?installationId=${installId}`)
      .then((r) => setRepos(r.repositories))
      .catch((e) => setError(e.message));
  }, [installId]);

  async function choose(r: Repo, rootDirectory = '') {
    setRepo(r);
    setDet(null);
    setError(null);
    setBusy(true);
    try {
      const res = await call<{ detection: Detection }>('/api/github/detect', { method: 'POST', body: { installationId: installId, repository: r.fullName, branch: r.defaultBranch, rootDirectory: rootDirectory || undefined } });
      const d = res.detection;
      setDet(d);
      setForm((f) => ({
        ...f, name: f.name || r.fullName.split('/')[1]!, branch: r.defaultBranch, rootDirectory, framework: d.framework,
        installCommand: d.installCommand ?? '', buildCommand: d.buildCommand ?? '', outputDirectory: d.outputDirectory ?? '',
        startCommand: d.startCommand ?? '', pythonVersion: d.pythonVersion ?? '3.12', port: String(d.port), healthCheckPath: d.healthCheckPath,
      }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detection failed');
    } finally {
      setBusy(false);
    }
  }

  async function create() {
    if (!repo) return;
    setBusy(true);
    setError(null);
    try {
      const py = form.framework === 'FASTAPI' || form.framework === 'FLASK';
      const { project } = await call<{ project: { id: string } }>('/api/projects', {
        method: 'POST',
        body: {
          name: form.name, installationId: installId, repository: repo.fullName, productionBranch: form.branch || undefined, rootDirectory: form.rootDirectory || undefined,
          settings: {
            framework: form.framework,
            installCommand: form.installCommand || null,
            buildCommand: form.buildCommand || null,
            outputDirectory: py ? null : form.outputDirectory || null,
            startCommand: py ? form.startCommand || null : null,
            pythonVersion: py ? form.pythonVersion : null,
            port: py ? Number(form.port) : undefined,
            healthCheckPath: py ? form.healthCheckPath : undefined,
            spaFallback: form.spaFallback,
          },
        },
      });
      if (deployNow) {
        const r = await call<{ deployment: { id: string } }>(`/api/projects/${project.id}/deployments`, { method: 'POST', body: {} });
        router.push(`/deployments/${r.deployment.id}`);
      } else router.push(`/projects/${project.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create project');
      setBusy(false);
    }
  }

  if (!installs) return <div className="flex justify-center p-12">{error ? <ErrorNote error={error} /> : <Spinner />}</div>;
  if (installs.length === 0) {
    return (
      <Card>
        <Empty title="Connect GitHub first" desc="You need an active GitHub App installation to import repositories." action={<Link href="/github" className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg">Go to GitHub settings</Link>} />
      </Card>
    );
  }
  const py = form.framework === 'FASTAPI' || form.framework === 'FLASK';
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm((f) => ({ ...f, [k]: e.target.value }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Import a repository</h1>
      <ErrorNote error={error} />
      <Card>
        <CardHeader title="1. Choose a repository" action={installs.length > 1 ? <Select aria-label="Installation" value={installId} onChange={(e) => setInstallId(e.target.value)} className="w-48">{installs.map((i) => <option key={i.id} value={i.id}>{i.local ? 'local' : i.accountLogin}</option>)}</Select> : undefined} />
        <div className="space-y-3 p-5">
          <Input aria-label="Filter repositories" placeholder="Filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {!repos ? <div className="flex justify-center p-6"><Spinner /></div> : repos.length === 0 ? <Empty title="No repositories available" desc="Grant the GitHub App access to at least one repository." /> : (
            <ul className="max-h-72 divide-y divide-line overflow-auto rounded-md border border-line">
              {repos.filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase())).map((r) => (
                <li key={r.id} className="flex items-center gap-3 px-4 py-2.5">
                  <span className="flex-1 truncate text-sm">{r.fullName} {r.private && <span className="text-xs text-muted">private</span>}</span>
                  {r.project ? <Link className="text-xs text-accent underline" href={`/projects/${r.project.id}`}>Imported</Link> : <Button variant={repo?.id === r.id ? 'primary' : 'outline'} disabled={busy} onClick={() => void choose(r)}>{repo?.id === r.id ? 'Selected' : 'Select'}</Button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </Card>

      {repo && (
        <Card>
          <CardHeader title="2. Configure" desc={det ? `Detected: ${det.label}${det.supported ? '' : ' (not fully supported)'}` : 'Detecting framework…'} />
          {!det ? <div className="flex justify-center p-8"><Spinner /></div> : (
            <div className="space-y-4 p-5">
              {det.notes.map((n) => <p key={n} className="rounded-md border border-line bg-panel-2 px-3 py-2 text-sm text-muted">{n}</p>)}
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Project name" htmlFor="name"><Input id="name" value={form.name} onChange={set('name')} maxLength={60} /></Field>
                <Field label="Production branch" htmlFor="branch"><Input id="branch" value={form.branch} onChange={set('branch')} /></Field>
                <Field label="Root directory" htmlFor="root" hint="Leave empty for the repository root."><Input id="root" value={form.rootDirectory} onChange={set('rootDirectory')} onBlur={() => repo && void choose(repo, form.rootDirectory)} placeholder="." /></Field>
                <Field label="Framework" htmlFor="fw"><Select id="fw" value={form.framework} onChange={set('framework')}>{FRAMEWORKS.map((f) => <option key={f}>{f}</option>)}</Select></Field>
                <Field label="Install command" htmlFor="ic"><Input id="ic" className="font-mono" value={form.installCommand} onChange={set('installCommand')} placeholder="npm ci" /></Field>
                <Field label="Build command" htmlFor="bc"><Input id="bc" className="font-mono" value={form.buildCommand} onChange={set('buildCommand')} placeholder="npm run build" /></Field>
                {!py && <Field label="Output directory" htmlFor="od" hint="Folder containing index.html after the build."><Input id="od" className="font-mono" value={form.outputDirectory} onChange={set('outputDirectory')} placeholder="dist" /></Field>}
                {py && (
                  <>
                    <Field label="Start command" htmlFor="sc" hint="Must listen on 0.0.0.0:$PORT."><Input id="sc" className="font-mono" value={form.startCommand} onChange={set('startCommand')} /></Field>
                    <Field label="Python version" htmlFor="pv"><Select id="pv" value={form.pythonVersion} onChange={set('pythonVersion')}>{['3.10', '3.11', '3.12', '3.13'].map((v) => <option key={v}>{v}</option>)}</Select></Field>
                    <Field label="Port" htmlFor="port"><Input id="port" type="number" min={1024} max={65535} value={form.port} onChange={set('port')} /></Field>
                    <Field label="Health check path" htmlFor="hc"><Input id="hc" value={form.healthCheckPath} onChange={set('healthCheckPath')} /></Field>
                  </>
                )}
              </div>
              {!py && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.spaFallback} onChange={(e) => setForm((f) => ({ ...f, spaFallback: e.target.checked }))} /> Single-page app (serve index.html for unknown routes)</label>}
              <p className="text-xs text-muted">Commands run inside an isolated sandbox container, never on the platform servers. Commit <span className="font-mono">{det.sha.slice(0, 7)}</span> was inspected.</p>
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={deployNow} onChange={(e) => setDeployNow(e.target.checked)} /> Deploy immediately</label>
              <div className="flex justify-end"><Button disabled={busy || !form.name} onClick={() => void create()}>{busy ? 'Creating…' : deployNow ? 'Create & deploy' : 'Create project'}</Button></div>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
