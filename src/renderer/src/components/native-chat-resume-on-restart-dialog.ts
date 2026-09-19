let pendingOpen = false
const listeners = new Set<() => void>()

// Why: the launch load and the status-bar entry both open this dialog, and either can fire before
// it subscribes. Keeping the request as an external snapshot prevents mount ordering from losing it.
export function requestNativeChatResumeOnRestartDialog(): void {
  pendingOpen = true
  for (const listener of listeners) {
    listener()
  }
}

export function consumeNativeChatResumeOnRestartDialogRequest(): void {
  if (!pendingOpen) {
    return
  }
  pendingOpen = false
  for (const listener of listeners) {
    listener()
  }
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
