let pendingOpen = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) {
    listener()
  }
}

// Why: the status-bar segment and the Cmd-J action both open this dialog, and either can fire before
// it subscribes. Keeping the request as an external snapshot prevents mount ordering from losing it.
export function requestCrossMachineRecoveryDialog(): void {
  pendingOpen = true
  notify()
}

export function consumeCrossMachineRecoveryDialogRequest(): void {
  if (!pendingOpen) {
    return
  }
  pendingOpen = false
  notify()
}

export function getCrossMachineRecoveryDialogRequest(): boolean {
  return pendingOpen
}

export function subscribeCrossMachineRecoveryDialog(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
