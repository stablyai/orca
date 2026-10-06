#!/usr/bin/env bash
# Usage: run-codex.sh ["prompt to submit at start"]
set -euo pipefail
/opt/agent-terminal-host/start-stub.sh
# Dummy key, named by env_key in ~/.codex/config.toml.
export STUB_OPENAI_API_KEY="sk-stub-0000000000000000000000000000"
cd "${AGENT_STUB_REPO:-/home/agent/demo-repo}"
if [ "$#" -gt 0 ] && [ -n "$1" ]; then
  exec codex "$1"
fi
exec codex
