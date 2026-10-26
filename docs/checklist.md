# Production-readiness checklist (all unchecked = not yet verified)

- [ ] `npm install`, `typecheck`, `lint`, `format:check`, `npm test` green in CI
- [ ] `next build` succeeds; Docker images build; Trivy clean
- [ ] `scripts/acceptance.mjs` passes against the compose stack
- [ ] Playwright journey passes
- [ ] Egress firewall verified on the real host (`verify-egress.sh`), incl. IPv6 and cloud metadata
- [ ] Stronger runtime isolation (gVisor/Kata/Firecracker) for untrusted tenants
- [ ] Real GitHub App tested end-to-end (webhook, token minting, private repo)
- [ ] Custom domain + on-demand TLS tested with real DNS
- [ ] Backup + restore drill; key-rotation drill
- [ ] Rate limits, quotas, abuse handling, WAF/CDN in front of edge
- [ ] MFA/SSO, email verification, password reset
- [ ] Monitoring, alerting, log shipping
- [ ] Load test of edge; S3 driver tested
- [ ] Independent security review / pen test
- [ ] Dev-local-git disabled and seed user removed in production
