const pendingOpen = new Set<string>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why: the launch load and the status-bar entry both open this dialog, and either can fire before
// it subscribes. Keeping the request as an external snapshot prevents mount ordering from losing it.
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
