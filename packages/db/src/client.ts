import { PrismaClient } from '@prisma/client';

const g = globalThis as unknown as { __deployforgePrisma?: PrismaClient };

export const prisma: PrismaClient =
  g.__deployforgePrisma ??
  new PrismaClient({
    log: process.env.PRISMA_LOG === 'query' ? ['query', 'warn', 'error'] : ['warn', 'error'],
  });

if (process.env.NODE_ENV !== 'production') g.__deployforgePrisma = prisma;
