let pendingOpen = false
const listeners = new Set<() => void>()

// Why: the nudge action can fire before the dialog subscribes. Keeping the
// request as an external snapshot prevents mount ordering from losing it.
export function requestSkillFreshnessUpdateDialog(): void {
  pendingOpen = true
  for (const listener of listeners) {
    listener()
  }
}

export function consumeSkillFreshnessUpdateDialogRequest(): boolean {
  const requested = pendingOpen
  pendingOpen = false
  if (requested) {
    for (const listener of listeners) {
      listener()
    }
  }
  return requested
}

export function getSkillFreshnessUpdateDialogRequest(): boolean {
  return pendingOpen
}

export function subscribeSkillFreshnessUpdateDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
