import type { RuntimeTerminalListResult } from '../../../../shared/runtime-types'

// Why: peerClient:listHostTerminals forwards the raw terminal.list RPC result
// through an `unknown` IPC boundary, so it needs the same runtime narrowing
// web-session-terminal-orphan-recovery.ts uses for the identical RPC result.
export function isTerminalListResult(value: unknown): value is RuntimeTerminalListResult {
  return (
    Boolean(value) &&
    typeof value === 'object' &&
    Array.isArray((value as { terminals?: unknown }).terminals)
  )
}
