import { useAppStore } from '../../../store/index'
import type { PortForwardEntry } from '../../../../../shared/remote-runtime/ssh/ssh-types'

/** Mirrors paired servers' forwards into the store; a renderer reload re-reads the ones main still holds. */
export function registerRuntimePortForwardsIpcBridge(unsubs: (() => void)[]): void {
  const api = window.api.runtimeEnvironments.portForwards
  if (!api) {
    return
  }
  const pushed = new Set<string>()
  unsubs.push(
    api.onChanged(({ environmentId, forwards }) => {
      pushed.add(environmentId)
      useAppStore.getState().setPortForwards(environmentId, forwards)
    })
  )
  void api
    .list()
    .then((forwards) => {
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
