const pendingOpen = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Keep opens as an external snapshot so requests arriving before subscription survive mount ordering.
export function requestNativeChatResumeOnRestartDialog(key = 'local'): void {
  pendingOpen.add(key)
  notify()
}

export function consumeNativeChatResumeOnRestartDialogRequest(key = 'local'): void {
  if (!pendingOpen.has(key)) {
    return
  }
  pendingOpen.delete(key)
  notify()
}

export function getNativeChatResumeOnRestartDialogRequest(key = 'local'): boolean {
  return pendingOpen.values().next().value === key
}

export function subscribeNativeChatResumeOnRestartDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
