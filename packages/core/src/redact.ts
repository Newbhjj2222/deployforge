/**
 * Log redaction. Every line that reaches the database, the SSE stream or the UI passes
 * through a redactor built from (a) the exact secret values the deployment can see and
 * (b) well-known credential shapes. It also strips internal filesystem prefixes.
 */

const MIN_SECRET_LENGTH = 6; // shorter values would mask ordinary words; documented limitation
const MAX_LINE_LENGTH = 4000;

const PATTERNS: Array<[RegExp, string]> = [
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'gh***'],
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, 'AWS***'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, 'sk-***'],
  [/(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***'],
  [/(:\/\/[^\s:/@]+:)[^\s@/]+(@)/g, '$1***$2'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/g, '[private key redacted]'],
  [/(x-access-token:)[^\s@]+/gi, '$1***'],
];

export interface RedactorOptions {
  /** Internal path prefixes to hide, e.g. ["/workspace", "/var/lib/deployforge"]. */
  hidePaths?: string[];
}

export type Redactor = (line: string) => string;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function createRedactor(secrets: Iterable<string>, opts: RedactorOptions = {}): Redactor {
  const values = [...new Set([...secrets].filter((s) => s.length >= MIN_SECRET_LENGTH))]
    // longest first so a secret that contains another secret is masked completely
    .sort((a, b) => b.length - a.length);
  const secretRe = values.length ? new RegExp(values.map(escapeRe).join('|'), 'g') : null;
  const pathRes = (opts.hidePaths ?? []).filter(Boolean).map((p) => new RegExp(escapeRe(p.replace(/\/+$/, '')) + '(?=/|\\b)', 'g'));

  return (line: string) => {
    let out = line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + '… [truncated]' : line;
    if (secretRe) out = out.replace(secretRe, '***');
    for (const [re, rep] of PATTERNS) out = out.replace(re, rep);
    for (const re of pathRes) out = out.replace(re, '~');
    // strip ANSI escape sequences and control characters (keeps logs safe to render)
    // eslint-disable-next-line no-control-regex
    out = out.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
    return out;
  };
}

/** What the UI shows in place of a secret value. Intentionally reveals nothing about the value. */
export const MASK = '••••••••';
