// Why: a pane holding a dormant recovered session connects only on this explicit
// "Start shell instead"; its record vanishing alone also happens when Resume claims it.
const shellReleaseListenersByPaneKey = new Map<string, Set<() => void>>()

export function releaseDormantRecoveryPaneToShell(paneKey: string): void {
  const listeners = shellReleaseListenersByPaneKey.get(paneKey)
  shellReleaseListenersByPaneKey.delete(paneKey)
  for (const listener of listeners ?? []) {
    listener()
  }
}

export function onDormantRecoveryPaneShellRelease(
  paneKey: string,
  listener: () => void
): () => void {
  const listeners = shellReleaseListenersByPaneKey.get(paneKey) ?? new Set()
  listeners.add(listener)
  shellReleaseListenersByPaneKey.set(paneKey, listeners)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && shellReleaseListenersByPaneKey.get(paneKey) === listeners) {
      shellReleaseListenersByPaneKey.delete(paneKey)
    }
  }
}
