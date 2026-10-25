// Management kills emit no pty:exit, so explicitly invalidate the status-bar session count.
const listeners = new Set<() => void>()

export function subscribeDaemonSessionInventoryInvalidated(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function notifyDaemonSessionInventoryInvalidated(): void {
  // Copy so a listener unsubscribing during dispatch cannot skip its neighbours.
  const snapshot = [...listeners]
  for (const listener of snapshot) {
    listener()
  }
}
