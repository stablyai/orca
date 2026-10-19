import { useAppStore } from '../../store'

export function registerScheduledMessagesIpcBridge(unsubs: (() => void)[]): void {
  const unsubscribe = window.api.scheduledMessages?.onUpdate?.((snapshot) => {
    useAppStore.getState().setScheduledMessagesSnapshot?.(snapshot)
  })
  if (unsubscribe) {
    unsubs.push(unsubscribe)
  }
  // An IPC round-trip can resolve after a push, so the hydrate carries its issuing
  // revision, and `active` drops a result that lands after this bridge was torn down.
  let active = true
  unsubs.push(() => {
    active = false
  })
  const revision = useAppStore.getState().scheduledMessagesRevision ?? 0
  // Promise.resolve: harnesses that stub window.api return a non-thenable from get().
  void Promise.resolve(window.api.scheduledMessages?.get?.())
    .then((snapshot) => {
      if (snapshot && active) {
        useAppStore.getState().hydrateScheduledMessagesSnapshot?.(snapshot, revision)
      }
    })
    .catch((error: unknown) => {
      console.warn('[ipc-bridge] scheduled messages hydrate failed:', error)
    })
}
