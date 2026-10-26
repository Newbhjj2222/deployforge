import type { Metadata } from 'next';
import './globals.css';

const name = process.env.PLATFORM_NAME ?? 'DeployForge';

export const metadata: Metadata = {
  title: { default: name, template: `%s · ${name}` },
  description: `${name} - self-hosted deployments from your Git repositories.`,
  robots: { index: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
