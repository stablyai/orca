import { useEffect, useSyncExternalStore } from 'react'
import { useAppStore } from '../store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import {
  createNativeChatRestartStore,
  localNativeChatRestartStore,
  type NativeChatRestartStore
} from './native-chat-resume-on-restart-store'

const stores = new Map<string, NativeChatRestartStore>()
const listeners = new Set<() => void>()
let revision = 0
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const empty: readonly string[] = []
const emptySnapshot = () => empty
const noSubscribe = () => () => {}

/** Consumers only subscribe; enrollment and discovery belong to the lifecycle effect. */
export function useNativeChatTargetRestartResuming(target: RuntimeClientTarget) {
  const owner = () =>
    target.kind === 'local' ? localNativeChatRestartStore : stores.get(target.environmentId)
  const store = useSyncExternalStore(subscribe, owner, owner)
  return useSyncExternalStore(
    store?.subscribe ?? noSubscribe,
    store?.getNativeChatRestartResuming ?? emptySnapshot,
    emptySnapshot
  )
}

export function useNativeChatRestartRuntimes() {
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const statuses = useAppStore((state) => state.runtimeStatusByEnvironmentId)
  useSyncExternalStore(
    subscribe,
    () => revision,
    () => revision
  )
  useEffect(() => {
    const enrolled = new Set(environments.map((env) => env.id))
    let changed = false
    for (const [id, store] of stores) {
      if (!enrolled.has(id)) {
        store.dispose()
        stores.delete(id)
        changed = true
      }
    }
    for (const environment of environments) {
      let store = stores.get(environment.id)
      if (!store) {
        store = createNativeChatRestartStore({ kind: 'environment', environmentId: environment.id })
        stores.set(environment.id, store)
        changed = true
      }
      store.observeRuntimeStatus(statuses.get(environment.id))
    }
    if (changed) {
      revision++
      listeners.forEach((listener) => listener())
    }
  }, [environments, statuses])
  return environments.flatMap((environment) => {
    const store = stores.get(environment.id)
    return store ? [{ environment, store }] : []
  })
}
