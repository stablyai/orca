import { useAppStore } from '@/store'

export function registerRuntimeOwnedSshAuthorityIpcBridge(unsubs: (() => void)[]): void {
  const { onRuntimeOwnedAuthorityChanged, listRuntimeOwnedAuthorities } = window.api.ssh
  if (!onRuntimeOwnedAuthorityChanged || !listRuntimeOwnedAuthorities) {
    return
  }
  let stopped = false
  let hydrating = true
  const pushedTargets = new Set<string>()
  const unsubscribe = onRuntimeOwnedAuthorityChanged(({ targetId, connectionGeneration }) => {
    if (!stopped) {
      if (hydrating) {
        pushedTargets.add(targetId)
      }
      useAppStore.getState().setRuntimeOwnedSshConnectionGeneration(targetId, connectionGeneration)
    }
  })
  unsubs.push(() => {
    stopped = true
    unsubscribe()
    pushedTargets.clear()
  })
  void listRuntimeOwnedAuthorities()
    .then((authorities) => {
      if (stopped) {
        return
      }
      const store = useAppStore.getState()
      const snapshot = new Map(
        authorities.map((entry) => [entry.targetId, entry.connectionGeneration])
      )
      // A removal push is also newer evidence; an old snapshot must not resurrect it.
      for (const targetId of new Set([
        ...snapshot.keys(),
        ...store.runtimeOwnedSshConnectionGenerations.keys()
      ])) {
        if (!pushedTargets.has(targetId)) {
          store.setRuntimeOwnedSshConnectionGeneration(targetId, snapshot.get(targetId) ?? null)
        }
      }
    })
    .catch((error) => console.warn('[ssh] failed to hydrate runtime-owned file authority:', error))
    .finally(() => {
      hydrating = false
      pushedTargets.clear()
    })
}
