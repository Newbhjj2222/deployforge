'use client';
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { Button, ErrorNote, Field, Input } from '@/components/ui';

export function LoginForm({ callbackUrl }: { callbackUrl: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        const f = new FormData(e.currentTarget);
        const res = await signIn('credentials', { email: String(f.get('email')), password: String(f.get('password')), redirect: false });
        setBusy(false);
        if (!res || res.error) return setError('Invalid email or password, or too many attempts. Try again later.');
        window.location.assign(callbackUrl);
      }}
    >
      <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required /></Field>
      <Field label="Password" htmlFor="password"><Input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
      <ErrorNote error={error} />
      <Button className="w-full" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</Button>
    </form>
  );
}
