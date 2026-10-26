#!/usr/bin/env bash
# Proves the build sandbox cannot reach private ranges / metadata, while public internet works.
# Exits non-zero if any "must be blocked" probe succeeds.
set -uo pipefail
NET=deployforge-build-egress
probe() { docker run --rm --network "$NET" --cap-drop ALL --security-opt no-new-privileges --user 10001:10001 alpine:3.20 "$@" >/dev/null 2>&1; }
fail=0
block() { if probe wget -q -T 4 -O- "$1"; then echo "FAIL  reachable (should be blocked): $1"; fail=1; else echo "ok    blocked: $1"; fi; }
allow() { if probe wget -q -T 8 -O- "$1"; then echo "ok    reachable: $1"; else echo "WARN  public internet probe failed: $1"; fi; }

block http://169.254.169.254/latest/meta-data/
block http://172.30.0.1/
block http://10.0.0.1/
block http://192.168.0.1/
block http://127.0.0.1:2375/version
allow https://registry.npmjs.org/
exit $fail
