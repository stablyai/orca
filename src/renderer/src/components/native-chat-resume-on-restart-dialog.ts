let pendingOpen = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Keep opens as an external snapshot so requests arriving before subscription survive mount ordering.
export function requestNativeChatResumeOnRestartDialog(): void {
  pendingOpen = true
  notify()
}

export function consumeNativeChatResumeOnRestartDialogRequest(): void {
  if (!pendingOpen) {
    return
  }
  pendingOpen = false
  notify()
}

export function getNativeChatResumeOnRestartDialogRequest(): boolean {
  return pendingOpen
}

export function subscribeNativeChatResumeOnRestartDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
