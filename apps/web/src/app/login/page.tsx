import Link from 'next/link';
import { signIn } from '@/auth';
import { AuthShell } from '@/components/auth-shell';
import { LoginForm } from './login-form';

export const metadata = { title: 'Sign in' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ callbackUrl?: string }> }) {
  const { callbackUrl } = await searchParams;
  const safe = callbackUrl && callbackUrl.startsWith('/') && !callbackUrl.startsWith('//') ? callbackUrl : '/dashboard';
  const githubEnabled = Boolean(process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET);
  return (
    <AuthShell title="Sign in" footer={<>No account? <Link className="text-accent underline" href="/register">Create one</Link></>}>
      <LoginForm callbackUrl={safe} />
      {githubEnabled && (
        <form
          className="mt-4"
          action={async () => {
            'use server';
            await signIn('github', { redirectTo: safe });
          }}
        >
          <button className="w-full rounded-md border border-line bg-panel px-3 py-2 text-sm hover:bg-panel-2">Continue with GitHub</button>
        </form>
      )}
    </AuthShell>
  );
}
