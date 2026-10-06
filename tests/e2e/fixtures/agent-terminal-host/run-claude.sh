#!/usr/bin/env bash
# Usage: run-claude.sh ["prompt to submit at start"]
set -euo pipefail
/opt/agent-terminal-host/start-stub.sh
export ANTHROPIC_BASE_URL="http://127.0.0.1:${STUB_PORT:-8089}"
# Dummy key; its last 20 characters are pre-approved in ~/.claude.json.
export ANTHROPIC_API_KEY="sk-ant-stub-0000000000000000000000000000"
export CLAUDE_CODE_NO_FLICKER=1
export DISABLE_TELEMETRY=1
export DISABLE_AUTOUPDATER=1
export DISABLE_ERROR_REPORTING=1
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
cd "${AGENT_STUB_REPO:-/home/agent/demo-repo}"
if [ "$#" -gt 0 ] && [ -n "$1" ]; then
  exec claude "$1"
fi
exec claude
