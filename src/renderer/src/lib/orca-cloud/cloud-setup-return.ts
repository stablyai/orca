// N9: orca://cloud/setup/return?session=… from the setup done page. Main validates the id and
// focuses Orca; this fans the event out to whoever is tracking that session (the setup session
// poller re-reads at once instead of waiting for its next tick). One IPC subscription is shared.
type Listener = (sessionId: string) => void

const listeners = new Set<Listener>()
let disposeIpc: (() => void) | null = null

function ensureIpc(): void {
  if (disposeIpc) {
    return
  }
  disposeIpc =
    globalThis.window?.api?.orcaProfiles?.onCloudSetupReturn?.((event) => {
      for (const listener of listeners) {
        listener(event.sessionId)
      }
    }) ?? null
}

/** Subscribe to setup return links; returns the unsubscribe. */
export function onCloudSetupReturn(listener: Listener): () => void {
  listeners.add(listener)
  ensureIpc()
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && disposeIpc) {
      disposeIpc()
      disposeIpc = null
    }
  }
}
