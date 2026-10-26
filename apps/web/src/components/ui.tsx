'use client';
import { cn } from '@/lib/cn';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react';

export function Button({ variant = 'primary', className, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'outline' }) {
  return (
    <button
      {...p}
      className={cn(
        'inline-flex items-center justify-center gap-2 rounded-md px-3.5 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50',
        variant === 'primary' && 'bg-accent text-accent-fg hover:brightness-110',
        variant === 'outline' && 'border border-line bg-panel hover:bg-panel-2',
        variant === 'ghost' && 'text-muted hover:bg-panel-2 hover:text-fg',
        variant === 'danger' && 'border border-danger/40 text-danger hover:bg-danger/10',
        className,
      )}
    />
  );
}

export const Card = ({ className, children }: { className?: string; children: ReactNode }) => (
  <section className={cn('rounded-lg border border-line bg-panel', className)}>{children}</section>
);

export const CardHeader = ({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) => (
  <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
    <div>
      <h2 className="text-sm font-semibold">{title}</h2>
      {desc && <p className="mt-1 text-sm text-muted">{desc}</p>}
    </div>
    {action}
  </header>
);

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

const inputCls = 'w-full rounded-md border border-line bg-bg px-3 py-2 text-sm placeholder:text-muted/60 focus:border-accent';
export const Input = ({ className, ...p }: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cn(inputCls, className)} />;
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cn(inputCls, className)} />;

const STATUS: Record<string, string> = {
  READY: 'border-accent/40 bg-accent/10 text-accent',
  FAILED: 'border-danger/40 bg-danger/10 text-danger',
  CANCELED: 'border-line bg-panel-2 text-muted',
  CANCELING: 'border-warn/40 bg-warn/10 text-warn',
  QUEUED: 'border-line bg-panel-2 text-muted',
  ACTIVE: 'border-accent/40 bg-accent/10 text-accent',
  PENDING_VERIFICATION: 'border-warn/40 bg-warn/10 text-warn',
  SUSPENDED: 'border-danger/40 bg-danger/10 text-danger',
};
export function StatusBadge({ status }: { status: string }) {
  const live = ['CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING'].includes(status);
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium', STATUS[status] ?? 'border-info/40 bg-info/10 text-info')}>
      {live && <span className="size-1.5 animate-pulse rounded-full bg-current" aria-hidden />}
      {status.replaceAll('_', ' ').toLowerCase()}
    </span>
  );
}

export const Spinner = () => <span role="status" aria-label="Loading" className="inline-block size-4 animate-spin rounded-full border-2 border-line border-t-accent" />;

export const Empty = ({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) => (
  <div className="px-6 py-14 text-center">
    <p className="font-medium">{title}</p>
    {desc && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{desc}</p>}
    {action && <div className="mt-4 flex justify-center">{action}</div>}
  </div>
);

export const ErrorNote = ({ error }: { error: string | null }) =>
  error ? <p role="alert" className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p> : null;

export const OkNote = ({ msg }: { msg: string | null }) =>
  msg ? <p role="status" className="rounded-md border border-accent/40 bg-accent/10 px-3 py-2 text-sm text-accent">{msg}</p> : null;

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <code className={cn('rounded bg-panel-2 px-1.5 py-0.5 font-mono text-xs', className)}>{children}</code>;
