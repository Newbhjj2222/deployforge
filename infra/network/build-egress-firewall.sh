#!/usr/bin/env bash
# Firewall for the build-egress network. Build containers may reach the PUBLIC internet (package registries, GitHub)
# but never the host, the platform's own services, private networks, or cloud metadata endpoints.
#
# Run as root on the Docker host after `docker compose up` created the network (bridge name df-build0, 172.30.0.0/24),
# and persist it (iptables-persistent / a systemd unit). Verify with:  scripts/verify-egress.sh
set -euo pipefail

BRIDGE="${BUILD_BRIDGE:-df-build0}"
SUBNET="${BUILD_SUBNET:-172.30.0.0/24}"
CHAIN="DEPLOYFORGE-BUILD"

iptables -N "$CHAIN" 2>/dev/null || iptables -F "$CHAIN"

# allow replies for connections the containers opened
iptables -A "$CHAIN" -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
# DNS to public resolvers only (the embedded 127.0.0.11 resolver is not used on this network)
iptables -A "$CHAIN" -p udp --dport 53 -d 1.1.1.1 -j RETURN
iptables -A "$CHAIN" -p udp --dport 53 -d 8.8.8.8 -j RETURN
# block everything private / special-use / metadata
for cidr in 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10 169.254.0.0/16 127.0.0.0/8 0.0.0.0/8 224.0.0.0/4 240.0.0.0/4; do
  iptables -A "$CHAIN" -d "$cidr" -j REJECT --reject-with icmp-net-prohibited
done
# SMTP is a classic abuse vector from build boxes
iptables -A "$CHAIN" -p tcp -m multiport --dports 25,465,587 -j REJECT
iptables -A "$CHAIN" -j RETURN

# DOCKER-USER is evaluated before Docker's own rules for forwarded traffic
iptables -C DOCKER-USER -i "$BRIDGE" -j "$CHAIN" 2>/dev/null || iptables -I DOCKER-USER -i "$BRIDGE" -j "$CHAIN"
# and traffic from containers to the host itself (INPUT chain)
iptables -C INPUT -i "$BRIDGE" -j REJECT 2>/dev/null || iptables -I INPUT -i "$BRIDGE" -m conntrack --ctstate NEW -j REJECT

echo "Applied $CHAIN to $BRIDGE ($SUBNET). Run scripts/verify-egress.sh to confirm."
