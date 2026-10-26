/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  reactStrictMode: true,
  // workspace packages are TypeScript sources
  transpilePackages: ['@deployforge/core', '@deployforge/db'],
  serverExternalPackages: ['@node-rs/argon2', '@prisma/client', 'ioredis'],
  experimental: { serverActions: { bodySizeLimit: '256kb' } },
};
export default nextConfig;
