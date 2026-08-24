import type { PtySessionInventorySnapshot } from '../../../../shared/pty-listed-session'

function isUnsupportedSessionInventoryMethod(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("No handler registered for 'pty:listSessionInventory'")
  )
}

async function readLegacyPartialInventory(): Promise<PtySessionInventorySnapshot> {
  return {
    sessions: await window.api.pty.listSessions(),
    hostIdBySessionId: {},
    retainedSessionIdsByHost: {},
    queriedHostIds: [],
    respondingHostIds: [],
    unavailableHostIds: [],
    // Why: the legacy array cannot prove which providers answered.
    complete: false
  }
}

export async function readResourceSessionInventory(): Promise<PtySessionInventorySnapshot> {
  const listSessionInventory = window.api.pty.listSessionInventory
  if (!listSessionInventory) {
    return readLegacyPartialInventory()
  }
  try {
    return await listSessionInventory()
  } catch (error) {
    if (!isUnsupportedSessionInventoryMethod(error)) {
      throw error
    }
    // Why: during mixed-version restart a new preload can outlive an old main
    // that has no handler for the additive detailed method.
    return readLegacyPartialInventory()
  }
}
