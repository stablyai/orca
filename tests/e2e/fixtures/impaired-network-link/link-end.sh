#!/usr/bin/env bash
# One end of a forwarding link: accepts TCP on LISTEN_PORT and forwards it to FORWARD_TO.
# Shaping is done from outside, on the veth between the two ends.
set -euo pipefail

exec socat -d "TCP-LISTEN:${LISTEN_PORT:?},fork,reuseaddr,nodelay" "TCP:${FORWARD_TO:?},nodelay"
