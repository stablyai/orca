import { useAppStore } from '../../store'

/**
 * Records that the owning relay disowned a PTY id, independently of whether a pane is attached.
 *
 * Why not the pane's exit handler: the relay disowns the id while the client is still reconnecting,
 * before any pane has remounted to hear it, and a parked or hidden pane has no handler registered
 * at all — that exit reaches the pre-handler buffer and nothing else. The reconnect gate reads the
 * store, so the signal has to land there.
 *
 * Not a death certificate: a restarted relay disowns ids it never minted, so this says only that no
 * relay will ever hand this id back. That is enough to give the pane a working shell — respawning
 * leaks the old process rather than killing it — and deliberately short of `exited`. A lost link, a
 * timeout and an identity mismatch send no exit at all
 * (docs/reference/ssh-execution-boundary.md).
 */
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
