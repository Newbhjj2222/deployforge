import type { ReactNode } from 'react';

export function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  const name = process.env.PLATFORM_NAME ?? 'DeployForge';
  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4 py-12">
      <p className="mb-8 text-center text-lg font-semibold tracking-tight"><span className="text-accent">▲</span> {name}</p>
      <div className="rounded-lg border border-line bg-panel p-6">
        <h1 className="mb-5 text-xl font-semibold">{title}</h1>
        {children}
      </div>
      {footer && <p className="mt-5 text-center text-sm text-muted">{footer}</p>}
    </main>
  );
}
