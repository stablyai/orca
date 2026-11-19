const listeners = new Set<() => void>()

/** Opens the Resource Manager on its Resources tab from outside the status bar, e.g. a toast. */
export function requestResourceManagerOpen(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function onResourceManagerOpenRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
