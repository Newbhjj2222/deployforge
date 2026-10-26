'use client';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Card, CardHeader, ErrorNote, Mono, Spinner, StatusBadge } from '@/components/ui';
import { call, duration, timeAgo } from '@/lib/client';
import { cn } from '@/lib/cn';

interface Dep {
  id: string; projectId: string; status: string; progress: number; environment: string; branch: string; commitSha: string; commitMessage: string | null;
  commitAuthor: string | null; url: string | null; failureReason: string | null; startedAt: string | null; finishedAt: string | null; createdAt: string; attempt: number;
  fileCount: number | null; runtime: string;
}
interface Log { seq: number; ts: string; level: string; stream: string; message: string }

const ACTIVE = ['QUEUED', 'CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING', 'CANCELING'];

export function DeploymentView({ id }: { id: string }) {
  const [dep, setDep] = useState<Dep | null>(null);
  const [isActive, setIsActive] = useState(false);
  const [logs, setLogs] = useState<Log[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [live, setLive] = useState(false);
  const [follow, setFollow] = useState(true);
  const box = useRef<HTMLPreElement>(null);

  const refresh = useCallback(() => call<{ deployment: Dep; isActive: boolean }>(`/api/deployments/${id}`).then((r) => { setDep(r.deployment); setIsActive(r.isActive); }).catch((e) => setError(e.message)), [id]);
  useEffect(() => void refresh(), [refresh]);

  // Server-Sent Events over fetch (so the session cookie + Accept header are sent): replays stored lines, then follows live.
  useEffect(() => {
    let closed = false;
    let after = -1;
    const run = async () => {
      const res = await fetch(`/api/deployments/${id}/logs`, { headers: { accept: 'text/event-stream' }, credentials: 'same-origin' });
      if (!res.ok || !res.body) { setError('Could not open the log stream'); return; }
      setLive(true);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = /^event: (.+)$/m.exec(block)?.[1];
          const data = /^data: (.+)$/m.exec(block)?.[1];
          if (!ev || !data) continue;
          const j = JSON.parse(data);
          if (ev === 'log' && j.seq > after) { after = j.seq; setLogs((l) => [...l, j]); }
          else if (ev === 'status') void refresh();
          else if (ev === 'done') { void refresh(); }
        }
      }
      setLive(false);
    };
    run().catch(() => setLive(false));
    return () => { closed = true; };
  }, [id, refresh]);

  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [logs, follow]);

  if (!dep) return <div className="flex justify-center p-12">{error ? <ErrorNote error={error} /> : <Spinner />}</div>;
  const running = ACTIVE.includes(dep.status);
  const steps = ['QUEUED', 'CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING', 'READY'];
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted"><Link className="underline" href={`/projects/${dep.projectId}`}>← Project</Link></p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight"><Mono className="text-base">{dep.commitSha.slice(0, 7)}</Mono> {dep.commitMessage ?? dep.branch}</h1>
          <p className="mt-1 text-sm text-muted">{dep.environment.toLowerCase()} · {dep.branch}{dep.commitAuthor ? ` · ${dep.commitAuthor}` : ''} · {timeAgo(dep.createdAt)} · {duration(dep.startedAt, dep.finishedAt)}{isActive ? ' · live' : ''}</p>
        </div>
        <div className="flex items-center gap-3">
          <StatusBadge status={dep.status} />
          {dep.url && <a href={dep.url} target="_blank" rel="noreferrer" className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg hover:brightness-110">Visit</a>}
          {running && dep.status !== 'CANCELING' && <Button variant="danger" onClick={async () => { try { await call(`/api/deployments/${id}/cancel`, { method: 'POST' }); void refresh(); } catch (e) { setError(e instanceof Error ? e.message : 'Failed'); } }}>Cancel</Button>}
        </div>
      </div>
      <ErrorNote error={error} />
      {dep.status === 'FAILED' && <ErrorNote error={dep.failureReason ?? 'Deployment failed'} />}
      <ol className="flex flex-wrap gap-2" aria-label="Progress">
        {steps.map((s) => {
          const idx = steps.indexOf(s);
          const cur = steps.indexOf(dep.status);
          const state = dep.status === 'READY' || idx < cur ? 'done' : idx === cur ? 'current' : 'todo';
          return <li key={s} className={cn('rounded-full border px-2.5 py-0.5 text-xs', state === 'done' && 'border-accent/40 text-accent', state === 'current' && 'border-info/50 bg-info/10 text-info', state === 'todo' && 'border-line text-muted')}>{s.toLowerCase()}</li>;
        })}
      </ol>
      <Card>
        <CardHeader title="Build logs" desc={live ? 'Streaming live' : running ? 'Reconnecting…' : `${logs.length} lines`} action={<label className="flex items-center gap-2 text-xs text-muted"><input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Follow</label>} />
        <pre ref={box} aria-label="Build log output" tabIndex={0} className="max-h-[32rem] overflow-auto bg-bg p-4 font-mono text-xs leading-relaxed">
          {logs.length === 0 ? <span className="text-muted">Waiting for output…</span> : logs.map((l) => (
            <div key={l.seq} className={cn('whitespace-pre-wrap break-words', l.level === 'ERROR' && 'text-danger', l.level === 'WARN' && 'text-warn', l.stream === 'SYSTEM' && l.level === 'INFO' && 'text-accent/90')}>
              <span className="select-none text-muted/60">{new Date(l.ts).toLocaleTimeString()} </span>{l.message}
            </div>
          ))}
        </pre>
      </Card>
    </div>
  );
}
