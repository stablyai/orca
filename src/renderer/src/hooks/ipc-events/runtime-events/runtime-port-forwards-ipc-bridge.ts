import { useAppStore } from '../../../store/index'
import type { PortForwardEntry } from '../../../../../shared/remote-runtime/ssh/ssh-types'
import { announceRestoredPortForwardMoves } from '../../../lib/workspace-ports/server-port-forward-open'

/** Mirrors paired servers' forwards into the store; a renderer reload re-reads the ones main still holds. */
export function registerRuntimePortForwardsIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.runtimeEnvironments.portForwards
  if (!api) {
    return
  }
  const pushed = new Set<string>()
  let stopped = false
  unsubs.push(() => {
    stopped = true
  })
  // Main holds moves until a window takes them, so a restore before this window loaded is still told.
  // Taken moves are shown even if this bridge stopped meanwhile: no other window will get them.
  const announceMoves = (): void => {
    void api
      .takeRestoredMoves()
      .then(announceRestoredPortForwardMoves)
      .catch((error) => console.error('Failed to read moved server port forwards:', error))
  }
  unsubs.push(
    api.onChanged(({ environmentId, forwards, movesPending }) => {
      pushed.add(environmentId)
      useAppStore.getState().setPortForwards(environmentId, forwards)
      if (movesPending) {
        announceMoves()
      }
    })
  )
  announceMoves()
  void api
    .list()
    .then((forwards) => {
      if (stopped) {
        return
      }
      const byEnvironment = new Map<string, PortForwardEntry[]>()
      for (const entry of forwards) {
        byEnvironment.set(entry.connectionId, [
          ...(byEnvironment.get(entry.connectionId) ?? []),
          entry
        ])
      }
      for (const [environmentId, entries] of byEnvironment) {
        if (!pushed.has(environmentId)) {
          useAppStore.getState().setPortForwards(environmentId, entries)
        }
      }
    })
    .catch((error) => console.error('Failed to read forwarded server ports:', error))
}
