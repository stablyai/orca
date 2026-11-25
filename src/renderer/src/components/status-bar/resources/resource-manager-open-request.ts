let openCount = 0

/** Toasts wait while the Resource Manager popover is open; it would cover them. */
export function isResourceManagerOpen(): boolean {
  return openCount > 0
}

export function trackResourceManagerOpen(): () => void {
  openCount += 1
  return () => {
    openCount -= 1
  }
}
