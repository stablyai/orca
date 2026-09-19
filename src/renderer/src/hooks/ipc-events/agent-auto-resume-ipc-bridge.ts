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
  const hydrate = <TSnapshot>(
    pending: TSnapshot | Promise<TSnapshot | undefined> | undefined,
    apply: (snapshot: TSnapshot) => void
  ): void => {
    void Promise.resolve(pending)
      .then((snapshot) => {
        if (snapshot && active) {
          apply(snapshot)
        }
      })
      .catch((error: unknown) => {
        console.warn('[ipc-bridge] hydrate failed:', error)
      })
  }

  const autoResumeRevision = useAppStore.getState().autoResumeRevision ?? 0
  hydrate(window.api.agentAutoResume?.get?.(), (snapshot) => {
    useAppStore.getState().hydrateAutoResumeSnapshot?.(snapshot, autoResumeRevision)
  })

  const unsubscribeScheduledMessages = window.api.scheduledMessages?.onUpdate?.((snapshot) => {
    useAppStore.getState().setScheduledMessagesSnapshot?.(snapshot)
  })
  if (unsubscribeScheduledMessages) {
    unsubs.push(unsubscribeScheduledMessages)
  }
  const scheduledRevision = useAppStore.getState().scheduledMessagesRevision ?? 0
  hydrate(window.api.scheduledMessages?.get?.(), (snapshot) => {
    useAppStore.getState().hydrateScheduledMessagesSnapshot?.(snapshot, scheduledRevision)
  })

  // No subscription: the renderer is the only writer of the armed set, so the
  // one-shot hydrate is enough to survive a reload.
  const watcherRevision = useAppStore.getState().rateLimitWatcherRevision ?? 0
  hydrate(window.api.rateLimitWatcher?.get?.(), (snapshot) => {
    useAppStore.getState().hydrateRateLimitWatcherSnapshot?.(snapshot, watcherRevision)
  })
}
