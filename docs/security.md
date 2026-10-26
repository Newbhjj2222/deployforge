# Security

## Threat model (summary)
Assets: customer source code and secrets, other tenants' deployments, the host, the control-plane database.
Adversaries: (1) malicious tenant running arbitrary build/runtime code, (2) unauthenticated internet attacker, (3) malicious repository content,
(4) a tenant trying to hijack another's domain, (5) a compromised dependency in a customer build.

## Controls implemented
| Risk | Control |
|---|---|
| Forged webhooks | HMAC-SHA256 over raw body, constant-time compare, delivery-id replay guard |
| Cross-tenant access | Every route authorizes through `requireProject/Deployment/Domain` helpers; foreign resources return **404** (no existence oracle) |
| CSRF | Origin check on all mutating requests (middleware) + SameSite cookies |
| Credential attacks | Argon2id, timing equalisation for unknown users, lockout, Redis rate limit (fail closed) |
| Secret exposure | AES-256-GCM, per-record AAD binding, key rotation via keyring; values never serialized; log redaction of every secret value |
| Build escape / abuse | non-root, `--cap-drop ALL`, `no-new-privileges`, memory/CPU/pids limits, wall-clock timeouts, read-only bind of sources where possible, env passed by name |
| SSRF / lateral movement from builds | build step: `--network none`; install step: dedicated bridge + iptables rules dropping RFC1918, link-local/metadata (169.254.169.254), SMTP (`infra/network/build-egress-firewall.sh`, check with `scripts/verify-egress.sh`) |
| Path traversal | `paths.ts` validators for every user-supplied path; artifact validator rejects symlinks/escapes; edge serves only manifest-listed files |
| Domain takeover | TXT challenge, unique index on active hostname, reserved/platform/wildcard/IP names rejected, TLS issuance only after verification (`ask` endpoint) |
| Rollback tampering | Artifacts immutable; manifest checksum verified before activation |
| Supply chain (platform) | pinned build targets; `npm audit` and Trivy in CI (never run yet) |

## Residual risks — read these
1. **Plain Docker is not a hostile multi-tenant boundary.** Kernel exploits escape containers. For untrusted public tenants, run the sandbox-agent
   hosts with gVisor (`runsc`), Kata Containers or Firecracker microVMs, on dedicated machines with no other workloads. The agent has a single
   place (`dockerargs.py`) where a runtime flag can be added.
2. **The sandbox-agent holds the Docker socket = root on its host.** It is network-isolated and token-protected, but compromise of the worker + token = host compromise. Rotate `SANDBOX_AGENT_TOKEN`, keep it off shared networks.
3. **Install-step egress** is necessary for package managers and therefore an exfiltration path for secrets that are exposed to install. Only BUILD-scoped variables are injected; avoid putting production credentials in build scope.
4. **Firewall script is host-specific** (DOCKER-USER chain). Verify with `scripts/verify-egress.sh` after every Docker/iptables change; IPv6 and nftables-only hosts need equivalent rules.
5. Python runtimes run user code with the project's runtime env: apps can read their own secrets (by design) but have no internet. Tell users.
6. No malware scanning of artifacts, no per-tenant bandwidth/request quotas, no WAF/DDoS protection. Put the edge behind a CDN/WAF for production.
7. Auth: no MFA/SSO yet; email verification not enforced in dev mode.
8. **Nothing here has been penetration-tested.** Dev-local-git mode (`DEV_LOCAL_GIT_ROOT`) must never be enabled in production.

## Reporting
Add your security contact to `SECURITY.md` before publishing.
