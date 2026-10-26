'use client';
import { useState } from 'react';
import { signIn } from 'next-auth/react';
import { Button, ErrorNote, Field, Input } from '@/components/ui';
import { call } from '@/lib/client';

export function RegisterForm() {
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
        const body = { name: String(f.get('name')), email: String(f.get('email')), password: String(f.get('password')) };
        try {
          await call('/api/auth/register', { method: 'POST', body });
          const res = await signIn('credentials', { email: body.email, password: body.password, redirect: false });
          if (res?.error) throw new Error('Account created, but sign-in failed. Please sign in manually.');
          window.location.assign('/dashboard');
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Registration failed');
          setBusy(false);
        }
      }}
    >
      <Field label="Name" htmlFor="name"><Input id="name" name="name" autoComplete="name" required maxLength={80} /></Field>
      <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required /></Field>
      <Field label="Password" htmlFor="password" hint="At least 10 characters."><Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required /></Field>
      <ErrorNote error={error} />
      <Button className="w-full" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</Button>
    </form>
  );
}
