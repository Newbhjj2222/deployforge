import { z } from 'zod';

/**
 * Queue contract (BullMQ on Redis is the ONLY job system).
 *
 * Authority:
 *  - PostgreSQL is authoritative for deployment/domain/project state, intent (outbox) and history.
 *  - Redis/BullMQ is authoritative only for *delivery*: which job is waiting/active/failed right now.
 *  - A job carries IDs, never state; workers re-read PostgreSQL and use compare-and-set updates.
 *  - The jobId is derived from the outbox row id so re-enqueueing is a no-op (idempotent delivery).
 */
export const QUEUES = {
  build: 'df-build',
  activate: 'df-activate',
  maintenance: 'df-maintenance',
} as const;

export const BuildJobDataSchema = z.object({
  deploymentId: z.string().min(1),
  outboxId: z.string().min(1),
});
export type BuildJobData = z.infer<typeof BuildJobDataSchema>;

export const ActivateJobDataSchema = z.object({
  deploymentId: z.string().min(1),
  outboxId: z.string().min(1),
  requestedByUserId: z.string().nullable().optional(),
});
export type ActivateJobData = z.infer<typeof ActivateJobDataSchema>;

export const OUTBOX_TYPES = {
  deploymentCreated: 'deployment.created',
  deploymentActivate: 'deployment.activate',
  projectCleanup: 'project.cleanup',
} as const;

export const jobIdFor = (outboxId: string) => `outbox_${outboxId}`;

export const BUILD_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5_000 },
  removeOnComplete: { age: 24 * 3600, count: 1000 },
  // failed jobs are KEPT: BullMQ's failed set is the dead-letter queue (see docs/operations.md)
  removeOnFail: false,
};

export const MAINTENANCE_JOBS = {
  domainRecheck: 'domain-recheck',
  tlsCheck: 'tls-check',
  artifactCleanup: 'artifact-cleanup',
  logRetention: 'log-retention',
  runtimeReconcile: 'runtime-reconcile',
  expirePendingDomains: 'expire-pending-domains',
} as const;
