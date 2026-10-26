/**
 * Development seed: creates a login you can use immediately.
 *   email:    dev@deployforge.local
 *   password: $SEED_PASSWORD (default "deployforge-dev-1")
 * Refuses to run when NODE_ENV=production.
 */
import { prisma } from './client';
import { hashPassword } from './password';

async function main() {
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed a production database');
  const email = 'dev@deployforge.local';
  const password = process.env.SEED_PASSWORD ?? 'deployforge-dev-1';
  const user = await prisma.user.upsert({
    where: { email },
    update: {},
    create: { email, name: 'Dev User', passwordHash: await hashPassword(password), emailVerified: new Date() },
  });
  const slug = 'dev-user';
  const org = await prisma.organization.upsert({
    where: { slug },
    update: {},
    create: { name: 'Dev User', slug, personal: true, members: { create: { userId: user.id, role: 'OWNER' } } },
  });
  console.log(`Seeded ${email} (org ${org.slug}). Password: ${process.env.SEED_PASSWORD ? '$SEED_PASSWORD' : password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
