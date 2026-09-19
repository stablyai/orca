import { useAppStore } from '../../store'

export function registerAgentAutoResumeIpcBridge(unsubs: (() => void)[]): void {
  const unsubscribeAutoResume = window.api.agentAutoResume?.onUpdate?.((snapshot) => {
    useAppStore.getState().setAutoResumeSnapshot?.(snapshot)
  })
  if (unsubscribeAutoResume) {
    unsubs.push(unsubscribeAutoResume)
  }
  // An IPC round-trip can resolve after a push, so each hydrate carries its issuing
  // revision, and `active` drops a result that lands after this bridge was torn down.
  let active = true
  unsubs.push(() => {
    active = false
  })

  // Promise.resolve: harnesses that stub window.api return a non-thenable from get().
  const autoResumeRevision = useAppStore.getState().autoResumeRevision ?? 0
  void Promise.resolve(window.api.agentAutoResume?.get?.()).then((snapshot) => {
    if (snapshot && active) {
      useAppStore.getState().hydrateAutoResumeSnapshot?.(snapshot, autoResumeRevision)
    }
  })

  // No subscription: the renderer is the only writer of the armed set, so the
  // one-shot hydrate is enough to survive a reload.
  const watcherRevision = useAppStore.getState().rateLimitWatcherRevision ?? 0
  void Promise.resolve(window.api.rateLimitWatcher?.get?.()).then((snapshot) => {
    if (snapshot && active) {
      useAppStore.getState().hydrateRateLimitWatcherSnapshot?.(snapshot, watcherRevision)
    }
  })
}
