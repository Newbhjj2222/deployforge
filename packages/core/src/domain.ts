import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { randomToken, safeEqual } from './crypto';

/**
 * Custom-domain rules.
 *  - Only exact hostnames. Wildcards are rejected (they would let one tenant capture a whole
 *    zone); see docs/security.md.
 *  - IPs, single-label names and internal/special-use suffixes are rejected.
 *  - The platform root domain and everything under it is reserved.
 *  - Ownership is proven with a TXT record containing a random per-domain token. A hostname is
 *    never routed on the strength of the user-supplied string alone.
 */

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const BLOCKED_SUFFIXES = [
  'localhost', 'local', 'internal', 'intranet', 'lan', 'home', 'corp', 'test', 'invalid', 'example',
  'onion', 'arpa',
];

export type HostnameCheck = { ok: true; hostname: string } | { ok: false; reason: string };

export function normalizeHostname(input: string): string {
  return domainToASCII(input.trim().toLowerCase().replace(/\.$/, ''));
}

export function validateCustomDomain(input: string, rootDomain: string): HostnameCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, reason: 'Enter a domain name.' };
  if (raw.includes('*')) return { ok: false, reason: 'Wildcard domains are not supported.' };
  if (/[\s/:@?#]/.test(raw)) return { ok: false, reason: 'Enter a bare hostname such as www.example.com.' };
  const hostname = normalizeHostname(raw);
  if (!hostname) return { ok: false, reason: 'Invalid domain name.' };
  if (hostname.length > 253) return { ok: false, reason: 'Domain name is too long.' };
  if (isIP(hostname) !== 0 || /^[0-9.]+$/.test(hostname)) {
    return { ok: false, reason: 'IP addresses are not allowed.' };
  }
  const labels = hostname.split('.');
  if (labels.length < 2) return { ok: false, reason: 'Domain must include a top-level domain.' };
  if (!labels.every((l) => LABEL.test(l))) return { ok: false, reason: 'Invalid domain name.' };
  const tld = labels[labels.length - 1]!;
  if (/^[0-9]+$/.test(tld)) return { ok: false, reason: 'Invalid top-level domain.' };
  if (BLOCKED_SUFFIXES.includes(tld)) return { ok: false, reason: 'This top-level domain is not allowed.' };
  const root = rootDomain.toLowerCase();
  if (hostname === root || hostname.endsWith('.' + root)) {
    return { ok: false, reason: `Domains under ${root} are managed by the platform.` };
  }
  return { ok: true, hostname };
}

export const CHALLENGE_PREFIX = '_deployforge-challenge';
export const CHALLENGE_VALUE_PREFIX = 'deployforge-verification=';

export const newChallengeToken = () => randomToken(24);
export const challengeRecordName = (hostname: string) => `${CHALLENGE_PREFIX}.${hostname}`;
export const challengeRecordValue = (token: string) => `${CHALLENGE_VALUE_PREFIX}${token}`;

/** Compare the TXT answers returned by DNS against the expected challenge, in constant time. */
export function txtMatchesChallenge(txtRecords: string[][], token: string): boolean {
  const expected = challengeRecordValue(token);
  let found = false;
  for (const chunks of txtRecords) {
    // long TXT values arrive split in 255-byte chunks
    const joined = chunks.join('');
    if (safeEqual(joined.trim(), expected)) found = true;
  }
  return found;
}

export interface DnsInstructions {
  txt: { type: 'TXT'; name: string; value: string };
  routing: Array<{ type: 'CNAME' | 'A' | 'AAAA'; name: string; value: string; note?: string }>;
}

export function dnsInstructions(
  hostname: string,
  token: string,
  opts: { cnameTarget: string; ipv4?: string; ipv6?: string },
): DnsInstructions {
  const isApex = hostname.split('.').length === 2;
  const routing: DnsInstructions['routing'] = [];
  if (!isApex) {
    routing.push({ type: 'CNAME', name: hostname, value: opts.cnameTarget });
  } else {
    if (opts.ipv4) routing.push({ type: 'A', name: hostname, value: opts.ipv4, note: 'Apex domains cannot use CNAME; use A (or ALIAS/ANAME if your DNS provider supports it).' });
    if (opts.ipv6) routing.push({ type: 'AAAA', name: hostname, value: opts.ipv6 });
    if (!opts.ipv4 && !opts.ipv6) {
      routing.push({ type: 'CNAME', name: hostname, value: opts.cnameTarget, note: 'Use ALIAS/ANAME/CNAME-flattening if your DNS provider supports it.' });
    }
  }
  return {
    txt: { type: 'TXT', name: challengeRecordName(hostname), value: challengeRecordValue(token) },
    routing,
  };
}

export const DOMAIN_RECHECK_GRACE_FAILURES = 72; // hourly checks => 3 days before suspension
