const SSH_PREFIX = 'SSH connection is not active'
// Produced by pty-connection.ts reportError() when a PTY reattach can't reach its SSH host.
const SSH_CONNECT_FAILURE_PREFIX = 'SSH connection failed'
// Matched with includes(): this arrives IPC-wrapped ("Error invoking remote method 'pty:…': Error: …").
const SSH_RELAY_LOST_MARKER = 'SSH connection lost, reconnecting'

/** A single error line the SSH reconnect banner already covers — hide instead of stacking under/over it. */
export function isSshReconnectOwnedTerminalError(error: string): boolean {
  return (
    error.startsWith(SSH_CONNECT_FAILURE_PREFIX) ||
    error.startsWith(SSH_PREFIX) ||
    error.includes(SSH_RELAY_LOST_MARKER)
  )
}

// Error messages are newline-joined for display, so keep unrelated lines regardless of order.
export function stripSshReconnectOwnedErrorLines(error: string): string | null {
  const kept = error
    .split('\n')
    .filter((line) => !isSshReconnectOwnedTerminalError(line))
    .join('\n')
  return kept.length > 0 ? kept : null
}
