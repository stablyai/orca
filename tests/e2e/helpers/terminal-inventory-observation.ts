import type { RuntimeTerminalListResult } from '../../../src/shared/runtime-types'

// The host's "can't answer yet" refusals: liveness still probing, or a live PTY whose pane binding
// is mid-mount (pty-terminal-summary.ts). A poll must retry them, not end on them.
const TRANSIENT_INVENTORY_REFUSALS = [
  'terminal_liveness_unavailable',
  'terminal_surface_ownership_unavailable'
]

export async function readFreshTerminalInventory(
  read: () => Promise<RuntimeTerminalListResult>
): Promise<RuntimeTerminalListResult | null> {
  try {
    return await read()
  } catch (error) {
    if (
      error instanceof Error &&
      TRANSIENT_INVENTORY_REFUSALS.some((refusal) => error.message.includes(refusal))
    ) {
      return null
    }
    throw error
  }
}
