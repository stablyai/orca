import type { RuntimeTerminalListResult } from '../../../src/shared/terminal/runtime/runtime-terminal-contracts'

// Retry host liveness and mid-mount binding refusals instead of ending the observation poll.
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
