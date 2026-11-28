// Main refuses to start a terminal in a pane it closed; the window's pane waits for main's frame to drop it.

export const TERMINAL_PANE_CLOSED = 'terminal_pane_closed'

export function isClosedPaneRefusal(message: string): boolean {
  return message.includes(TERMINAL_PANE_CLOSED)
}

/** What a pane does after a fresh start left it with no terminal. */
export function unboundSpawnOutcome(refusal: {
  ownerRefused: boolean
  paneClosed: boolean
  deferred: boolean
}): 'owner-retry' | 'wait' | 'recover' {
  if (refusal.ownerRefused) {
    return 'owner-retry'
  }
  // A closed pane's remount would only disturb its siblings; a deferred restore would defer again.
  return refusal.paneClosed || refusal.deferred ? 'wait' : 'recover'
}
