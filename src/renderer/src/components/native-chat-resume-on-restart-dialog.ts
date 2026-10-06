let pendingOpen = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why: the launch load and the status-bar entry both open this dialog, and either can fire before
// it subscribes. Keeping the request as an external snapshot prevents mount ordering from losing it.
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
