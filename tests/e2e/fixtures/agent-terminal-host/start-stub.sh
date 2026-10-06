#!/usr/bin/env bash
# Starts the stub server unless one already answers on the port.
set -euo pipefail
export STUB_PORT="${STUB_PORT:-8089}"
export STUB_LOG="${STUB_LOG:-/tmp/agent-stub/requests.log}"
export STUB_CONFIG="${STUB_CONFIG:-/tmp/agent-stub/config.json}"
mkdir -p "$(dirname "$STUB_LOG")"
probe() { curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:${STUB_PORT}/healthz"; }
if ! probe 2>/dev/null; then
  setsid nohup node /opt/agent-terminal-host/stub-server.js >>"$(dirname "$STUB_LOG")/stub-server.out" 2>&1 </dev/null &
  for _ in $(seq 1 50); do
    probe 2>/dev/null && break
    sleep 0.1
  done
  probe
fi
