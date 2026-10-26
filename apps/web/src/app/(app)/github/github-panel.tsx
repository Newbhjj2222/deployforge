'use client';
import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button, Card, CardHeader, Empty, ErrorNote, OkNote, Spinner, StatusBadge } from '@/components/ui';
import { call } from '@/lib/client';

interface Data {
  installations: { id: string; accountLogin: string; accountType: string; status: string; org: { name: string }; projects: number; local: boolean }[];
  github: { configured: boolean; installUrl: string | null; setupHelp: string | null };
  devLocal: boolean;
}

export function GitHubPanel() {
  const sp = useSearchParams();
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState<string | null>(sp.get('error'));
  const [ok, setOk] = useState<string | null>(sp.get('connected') ? 'GitHub connected.' : null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await call<Data>('/api/github/installations'));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }, []);
  useEffect(() => void load(), [load]);

  if (!data) return <div className="flex justify-center p-12">{error ? <ErrorNote error={error} /> : <Spinner />}</div>;
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">GitHub connections</h1>
      <ErrorNote error={error} />
      <OkNote msg={ok} />
      {!data.github.configured && (
        <Card className="border-warn/40">
          <CardHeader title="GitHub App is not configured" desc={data.github.setupHelp ?? undefined} />
          <p className="px-5 py-4 text-sm text-muted">Follow <code className="font-mono">docs/github-app.md</code> to create the App, then restart the control plane.</p>
        </Card>
      )}
      <Card>
        <CardHeader
          title="Installations"
          desc="Repositories you can import come from your GitHub App installations."
          action={
            <div className="flex gap-2">
              {data.github.installUrl && <a href={data.github.installUrl} className="rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-accent-fg hover:brightness-110">Install GitHub App</a>}
              {data.devLocal && !data.installations.some((i) => i.local) && (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true);
                    try {
                      await call('/api/github/connect', { method: 'POST', body: { local: true } });
                      setOk('Local development repositories enabled.');
                      await load();
                    } catch (e) {
                      setError(e instanceof Error ? e.message : 'Failed');
                    } finally {
                      setBusy(false);
                    }
                  }}
                >
                  Use local dev repositories
                </Button>
              )}
            </div>
          }
        />
        {data.installations.length === 0 ? (
          <Empty title="Nothing connected" desc="Install the GitHub App on your account or organization to import repositories." />
        ) : (
          <ul className="divide-y divide-line">
            {data.installations.map((i) => (
              <li key={i.id} className="flex items-center gap-4 px-5 py-4">
                <div className="flex-1">
                  <p className="font-medium">{i.local ? 'Local development repositories' : i.accountLogin}</p>
                  <p className="text-xs text-muted">{i.accountType} · {i.org.name} · {i.projects} project{i.projects === 1 ? '' : 's'}</p>
                </div>
                <StatusBadge status={i.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
