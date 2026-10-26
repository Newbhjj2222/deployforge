/**
 * Deployment lifecycle.
 *
 *   QUEUED -> CLONING -> INSTALLING -> BUILDING -> UPLOADING -> DEPLOYING -> READY
 *
 * Any in-progress state may move to FAILED, to CANCELING (cancel requested) or back to QUEUED
 * (infrastructure failure with retries left - the worker re-queues the deployment).
 * CANCELING resolves to CANCELED (or FAILED when the work failed first).
 * QUEUED may be canceled directly. READY / FAILED / CANCELED are terminal.
 */
export const DEPLOYMENT_STATUSES = [
  'QUEUED',
  'CLONING',
  'INSTALLING',
  'BUILDING',
  'UPLOADING',
  'DEPLOYING',
  'READY',
  'FAILED',
  'CANCELING',
  'CANCELED',
] as const;

export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

const IN_PROGRESS: DeploymentStatus[] = ['CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING'];

const TRANSITIONS: Record<DeploymentStatus, DeploymentStatus[]> = {
  QUEUED: ['CLONING', 'CANCELED', 'FAILED'],
  CLONING: ['INSTALLING', 'BUILDING', 'FAILED', 'CANCELING', 'QUEUED'],
  INSTALLING: ['BUILDING', 'FAILED', 'CANCELING', 'QUEUED'],
  BUILDING: ['UPLOADING', 'FAILED', 'CANCELING', 'QUEUED'],
  UPLOADING: ['DEPLOYING', 'FAILED', 'CANCELING', 'QUEUED'],
  DEPLOYING: ['READY', 'FAILED', 'CANCELING', 'QUEUED'],
  CANCELING: ['CANCELED', 'FAILED'],
  READY: [],
  FAILED: [],
  CANCELED: [],
};

export const TERMINAL_STATUSES: DeploymentStatus[] = ['READY', 'FAILED', 'CANCELED'];

export const isTerminal = (s: DeploymentStatus) => TERMINAL_STATUSES.includes(s);
export const isInProgress = (s: DeploymentStatus) => IN_PROGRESS.includes(s);
export const isCancelable = (s: DeploymentStatus) => s === 'QUEUED' || isInProgress(s);

export const canTransition = (from: DeploymentStatus, to: DeploymentStatus) =>
  TRANSITIONS[from].includes(to);

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: DeploymentStatus,
    readonly to: DeploymentStatus,
  ) {
    super(`Invalid deployment transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}

export function assertTransition(from: DeploymentStatus, to: DeploymentStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** States from which a deployment can be moved to `to`; used for compare-and-set updates. */
export const statesAllowing = (to: DeploymentStatus): DeploymentStatus[] =>
  DEPLOYMENT_STATUSES.filter((s) => canTransition(s, to));

const PROGRESS: Record<DeploymentStatus, number> = {
  QUEUED: 0,
  CLONING: 10,
  INSTALLING: 30,
  BUILDING: 55,
  UPLOADING: 80,
  DEPLOYING: 92,
  READY: 100,
  FAILED: 100,
  CANCELING: 100,
  CANCELED: 100,
};

export const progressFor = (s: DeploymentStatus) => PROGRESS[s];
