import { useAppStore } from '../../store'

/** Record disowned IDs even while panes are unmounted so reconnect can replace unusable handles. Disowning proves no future reattach, never process exit; respawn may leave the old process alive. Link loss/timeouts/identity mismatches send no exit (ssh-execution-boundary.md). */
export function registerPtySourceDisownedIpcBridge(unsubs: (() => void)[]): void {
  const unsubscribe = window.api.pty?.onExit?.((payload) => {
    if (payload.ptySourceDisowned !== true) {
      return
    }
    useAppStore.getState().markPtySourceDisowned(payload.id)
  })
  if (unsubscribe) {
    unsubs.push(unsubscribe)
  }
}
