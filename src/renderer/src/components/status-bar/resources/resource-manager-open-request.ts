const listeners = new Set<() => void>()
let openCount = 0

/** Opens the Resource Manager on its Resources tab from outside the status bar, e.g. a toast. */
export function requestResourceManagerOpen(): void {
  for (const listener of listeners) {
    listener()
  }
}

/** False when the status-bar item is hidden, so a toast never offers an Open Resources that does nothing. */
export function hasResourceManager(): boolean {
  return listeners.size > 0
}

export function onResourceManagerOpenRequest(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Toasts wait while the popover is open; it would cover them. */
export function isResourceManagerOpen(): boolean {
  return openCount > 0
}

export function trackResourceManagerOpen(): () => void {
  openCount += 1
  return () => {
    openCount -= 1
  }
}
