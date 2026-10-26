import { describe, expect, it } from 'vitest';
import {
  DEPLOYMENT_STATUSES,
  InvalidTransitionError,
  assertTransition,
  canTransition,
  isCancelable,
  isTerminal,
  statesAllowing,
} from '../src/state-machine';

describe('deployment state machine', () => {
  it('allows the happy path in order', () => {
    const path = ['QUEUED', 'CLONING', 'INSTALLING', 'BUILDING', 'UPLOADING', 'DEPLOYING', 'READY'] as const;
    for (let i = 0; i < path.length - 1; i++) expect(canTransition(path[i]!, path[i + 1]!)).toBe(true);
  });

  it('never leaves a terminal state', () => {
    for (const t of ['READY', 'FAILED', 'CANCELED'] as const) {
      expect(isTerminal(t)).toBe(true);
      for (const to of DEPLOYMENT_STATUSES) expect(canTransition(t, to)).toBe(false);
    }
  });

  it('cannot skip validation: BUILDING cannot jump to READY', () => {
    expect(canTransition('BUILDING', 'READY')).toBe(false);
    expect(canTransition('UPLOADING', 'READY')).toBe(false);
    expect(statesAllowing('READY')).toEqual(['DEPLOYING']);
  });

  it('cancellation rules', () => {
    expect(canTransition('QUEUED', 'CANCELED')).toBe(true);
    expect(canTransition('BUILDING', 'CANCELING')).toBe(true);
    expect(canTransition('CANCELING', 'CANCELED')).toBe(true);
    expect(canTransition('CANCELING', 'READY')).toBe(false);
    expect(isCancelable('READY')).toBe(false);
    expect(isCancelable('QUEUED')).toBe(true);
  });

  it('allows re-queue of in-progress work for retries but not for terminal states', () => {
    expect(canTransition('BUILDING', 'QUEUED')).toBe(true);
    expect(canTransition('FAILED', 'QUEUED')).toBe(false);
  });

  it('assertTransition throws a typed error', () => {
    expect(() => assertTransition('READY', 'BUILDING')).toThrow(InvalidTransitionError);
  });
});
