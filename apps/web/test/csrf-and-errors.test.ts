import { describe, expect, it } from 'vitest';
import { toErrorBody, AppError } from '@deployforge/core';
import { CreateEnv, CreateProject, Register } from '../src/lib/schemas';

describe('request validation schemas', () => {
  it('rejects malformed env vars (reserved shapes, bad keys, scope)', () => {
    expect(CreateEnv.safeParse({ key: '1BAD', value: 'x', environment: 'PRODUCTION' }).success).toBe(false);
    expect(CreateEnv.safeParse({ key: 'OK_KEY', value: 'x', environment: 'STAGING' }).success).toBe(false);
    expect(CreateEnv.safeParse({ key: 'OK_KEY', value: 'x', environment: 'PRODUCTION' }).success).toBe(true);
    expect(CreateEnv.safeParse({ key: 'A'.repeat(200), value: 'x', environment: 'PRODUCTION' }).success).toBe(false);
  });

  it('rejects dangerous project settings', () => {
    const base = { name: 'n', installationId: 'i', repository: 'o/r', settings: { framework: 'VITE' } };
    expect(CreateProject.safeParse(base).success).toBe(true);
    expect(CreateProject.safeParse({ ...base, slug: 'www' }).success).toBe(false);
    expect(CreateProject.safeParse({ ...base, rootDirectory: '../etc' }).success).toBe(false);
    expect(CreateProject.safeParse({ ...base, settings: { framework: 'VITE', outputDirectory: '/etc' } }).success).toBe(false);
    expect(CreateProject.safeParse({ ...base, settings: { framework: 'VITE', buildCommand: 'x\u0000y' } }).success).toBe(false);
    expect(CreateProject.safeParse({ ...base, productionBranch: '-rf' }).success).toBe(false);
    expect(CreateProject.safeParse({ ...base, settings: { framework: 'EVIL' } }).success).toBe(false);
    expect(CreateProject.safeParse({ ...base, settings: { framework: 'FASTAPI', port: 80 } }).success).toBe(false);
  });

  it('registration requires a strong-enough password and valid email', () => {
    expect(Register.safeParse({ name: 'A', email: 'a@b.co', password: 'short' }).success).toBe(false);
    expect(Register.safeParse({ name: 'A', email: 'nope', password: 'longenoughpassword' }).success).toBe(false);
    expect(Register.safeParse({ name: 'A', email: 'A@B.co', password: 'longenoughpassword' })).toMatchObject({ success: true });
  });
});

describe('error responses never leak internals', () => {
  it('maps AppError to its public body and everything else to a generic 500', () => {
    expect(toErrorBody(new AppError('not_found', 'Project not found'))).toEqual({ status: 404, body: { error: { code: 'not_found', message: 'Project not found', details: undefined } } });
    const r = toErrorBody(new Error('connect ECONNREFUSED 10.0.0.5:5432 password=hunter2'));
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(JSON.stringify(r.body)).not.toContain('10.0.0.5');
  });
});
