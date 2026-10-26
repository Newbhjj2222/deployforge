import 'server-only';
import dns from 'node:dns/promises';

/**
 * TXT resolution for ownership checks goes to explicitly configured public resolvers (DNS_RESOLVERS),
 * never to whatever the host's resolver is - this avoids split-horizon / internal-zone answers and stale
 * local caches. Only TXT lookups of `_deployforge-challenge.<hostname>` are ever made; the hostname was
 * validated and normalised before it was stored, and no request is made to the looked-up address, so
 * this path is not an SSRF / DNS-rebinding vector.
 */
const resolver = new dns.Resolver({ timeout: 4000, tries: 2 });
resolver.setServers((process.env.DNS_RESOLVERS ?? '1.1.1.1,8.8.8.8').split(',').map((s) => s.trim()).filter(Boolean));
export const resolveTxt = (name: string) => resolver.resolveTxt(name);
