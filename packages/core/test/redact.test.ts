import { describe, expect, it } from 'vitest';
import { createRedactor } from '../src/redact';

describe('log redaction', () => {
  const redact = createRedactor(['hunter2-secret', 'abc'], { hidePaths: ['/workspace', '/var/lib/deployforge'] });

  it('masks known secret values (longest first) and ignores too-short ones', () => {
    expect(redact('token is hunter2-secret ok')).toBe('token is *** ok');
    expect(redact('abc stays')).toBe('abc stays');
  });

  it('masks well-known credential shapes', () => {
    expect(redact('using ghs_' + 'A'.repeat(36))).toBe('using gh***');
    expect(redact('key AKIAABCDEFGHIJKLMNOP')).toBe('key AWS***');
    expect(redact('Authorization: Bearer abcdefghijklmnop1234')).toBe('Authorization: Bearer ***');
    expect(redact('git clone https://user:pa55word@github.com/x/y.git')).toBe('git clone https://user:***@github.com/x/y.git');
    expect(redact('-----BEGIN RSA PRIVATE KEY-----')).toBe('[private key redacted]');
  });

  it('hides internal paths', () => {
    expect(redact('error in /workspace/abc/src/index.js')).toBe('error in ~/abc/src/index.js');
  });

  it('strips ANSI and control characters and truncates long lines', () => {
    expect(redact('\u001b[31mred\u001b[0m')).toBe('red');
    expect(redact('a'.repeat(5000)).length).toBeLessThan(4100);
  });

  it('escapes regex metacharacters in secrets', () => {
    const r = createRedactor(['p@ss.w(rd)+*']);
    expect(r('x p@ss.w(rd)+* y')).toBe('x *** y');
  });
});
