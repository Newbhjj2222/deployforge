import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth, signOut } from '@/auth';

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  if (!session?.user?.id) redirect('/login');
  const name = process.env.PLATFORM_NAME ?? 'DeployForge';
  const links = [
    ['/dashboard', 'Overview'],
    ['/projects', 'Projects'],
    ['/github', 'GitHub'],
  ] as const;
  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-line bg-bg/90 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-6 px-4">
          <Link href="/dashboard" className="font-semibold tracking-tight"><span className="text-accent">▲</span> {name}</Link>
          <nav aria-label="Main" className="flex gap-1 text-sm">
            {links.map(([href, label]) => (
              <Link key={href} href={href} className="rounded-md px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg">{label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm">
            <span className="hidden text-muted sm:inline">{session.user.email}</span>
            <form action={async () => { 'use server'; await signOut({ redirectTo: '/login' }); }}>
              <button className="rounded-md px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg">Sign out</button>
            </form>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">{children}</main>
    </div>
  );
}
