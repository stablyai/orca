#!/usr/bin/env bash
set -euo pipefail

if [[ -n "${AUTHORIZED_KEY:-}" ]]; then
  printf '%s\n' "$AUTHORIZED_KEY" > /home/tester/.ssh/authorized_keys
  chown tester:tester /home/tester/.ssh/authorized_keys
  chmod 600 /home/tester/.ssh/authorized_keys
fi

ssh-keygen -A >/dev/null
exec /usr/sbin/sshd -D -e
