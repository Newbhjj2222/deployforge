import { describe, expect, it } from 'vitest';
import {
  challengeRecordName,
  challengeRecordValue,
  dnsInstructions,
  txtMatchesChallenge,
  validateCustomDomain,
} from '../src/domain';
import { newPreviewHostname, slugify, validateSlug } from '../src/slug';

const ROOT = 'deployforge.dev';

describe('custom domain validation', () => {
  it('accepts normal hostnames and normalises case / trailing dot', () => {
    expect(validateCustomDomain('WWW.Example.com.', ROOT)).toEqual({ ok: true, hostname: 'www.example.com' });
    expect(validateCustomDomain('example.co.uk', ROOT).ok).toBe(true);
  });

  it('rejects wildcards, IPs, single labels, internal TLDs, URLs and the platform domain', () => {
    const bad = [
      '*.example.com', '127.0.0.1', '10.0.0.5', '999.1.1.1', 'localhost', 'intranet', 'foo.internal',
      'foo.local', 'http://example.com', 'example.com/path', 'user@example.com', 'exa mple.com',
      'deployforge.dev', 'evil.deployforge.dev', '-bad.example.com', 'a..b.com', '', 'example.123',
    ];
    for (const d of bad) expect(validateCustomDomain(d, ROOT).ok, d).toBe(false);
  });

  it('converts IDN to punycode', () => {
    const r = validateCustomDomain('bücher.com', ROOT);
    expect(r.ok && r.hostname).toBe('xn--bcher-kva.com');
  });
});

describe('ownership challenge', () => {
  it('builds record names and values', () => {
    expect(challengeRecordName('www.example.com')).toBe('_deployforge-challenge.www.example.com');
    expect(challengeRecordValue('tok')).toBe('deployforge-verification=tok');
  });

  it('matches only the exact token (handles chunked TXT answers)', () => {
    const v = challengeRecordValue('tok123');
    expect(txtMatchesChallenge([[v]], 'tok123')).toBe(true);
    expect(txtMatchesChallenge([[v.slice(0, 10), v.slice(10)]], 'tok123')).toBe(true);
    expect(txtMatchesChallenge([['v=spf1 -all'], [v]], 'tok123')).toBe(true);
    expect(txtMatchesChallenge([[v]], 'other')).toBe(false);
    expect(txtMatchesChallenge([[v + 'x']], 'tok123')).toBe(false);
    expect(txtMatchesChallenge([], 'tok123')).toBe(false);
  });

  it('gives CNAME for subdomains and A for apex', () => {
    const sub = dnsInstructions('www.example.com', 't', { cnameTarget: 'edge.deployforge.dev', ipv4: '1.2.3.4' });
    expect(sub.routing[0]).toMatchObject({ type: 'CNAME', value: 'edge.deployforge.dev' });
    const apex = dnsInstructions('example.com', 't', { cnameTarget: 'edge.deployforge.dev', ipv4: '1.2.3.4' });
    expect(apex.routing[0]).toMatchObject({ type: 'A', value: '1.2.3.4' });
  });
});

describe('project slugs', () => {
  it('slugifies', () => {
    expect(slugify('My Cool App!!')).toBe('my-cool-app');
    expect(slugify('  Ünïcode__name ')).toBe('unicode-name');
  });

  it('rejects reserved, malformed and preview-shaped slugs', () => {
    expect(validateSlug('my-app').ok).toBe(true);
    expect(validateSlug('www').ok).toBe(false);
    expect(validateSlug('api').ok).toBe(false);
    expect(validateSlug('-bad').ok).toBe(false);
    expect(validateSlug('a--b').ok).toBe(false);
    expect(validateSlug('UPPER').ok).toBe(false);
    expect(validateSlug('my-app-1a2b3c4d').ok).toBe(false); // would collide with preview hostnames
  });

  it('preview hostnames fit in a DNS label', () => {
    const h = newPreviewHostname('a'.repeat(40), ROOT);
    expect(h.split('.')[0]!.length).toBeLessThanOrEqual(63);
  });
});
