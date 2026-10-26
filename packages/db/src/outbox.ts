import { prisma } from './client';

export interface OutboxRow {
  id: string;
  type: string;
  aggregateId: string;
  payload: unknown;
  attempts: number;
}

const MAX_ATTEMPTS = 10;

/**
 * Transactional-outbox dispatcher. Selects pending rows with `FOR UPDATE SKIP LOCKED` (so several
 * workers can dispatch concurrently without duplicates), hands each to `deliver` INSIDE the
 * transaction, and marks it SENT only if delivery succeeded. If the process dies after delivery
 * but before commit, the row is re-delivered; `deliver` MUST be idempotent (BullMQ jobId = f(row id)).
 */
export async function dispatchOutbox(
  deliver: (row: OutboxRow) => Promise<void>,
  limit = 25,
): Promise<number> {
  return prisma.$transaction(
    async (tx) => {
      const rows = await tx.$queryRaw<OutboxRow[]>`
        SELECT id, type, "aggregateId", payload, attempts
        FROM "OutboxEvent"
        WHERE status = 'PENDING' AND "availableAt" <= now()
        ORDER BY "createdAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`;
      let sent = 0;
      for (const row of rows) {
        try {
          await deliver(row);
          await tx.outboxEvent.update({ where: { id: row.id }, data: { status: 'SENT', sentAt: new Date(), attempts: { increment: 1 }, lastError: null } });
          sent++;
        } catch (err) {
          const attempts = row.attempts + 1;
          const backoffSec = Math.min(300, 2 ** attempts);
          await tx.outboxEvent.update({
            where: { id: row.id },
            data: {
              attempts,
              lastError: String((err as Error).message ?? err).slice(0, 500),
              status: attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING',
              availableAt: new Date(Date.now() + backoffSec * 1000),
            },
          });
        }
      }
      return sent;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
