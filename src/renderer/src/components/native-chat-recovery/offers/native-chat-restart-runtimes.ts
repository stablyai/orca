import { useEffect, useSyncExternalStore } from 'react'
import { useRuntimeStatusByEnvironmentId } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { useAppStore } from '../../../store/index'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  createNativeChatRestartStore,
  type NativeChatRestartStore
} from './native-chat-restart-runtime-store'
import { localNativeChatRestartStore } from './native-chat-resume-on-restart-store'
import { isResumeRunPendingPhase } from '../runs/native-chat-resume-run'

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

/** Whether this chat is still queued or starting in its host's resume run, as the status bar's
 *  "Resuming agents" counts it. */
export function nativeChatRestartStillStarting(
  target: RuntimeClientTarget,
  sessionId: string
): boolean {
  const store =
    target.kind === 'local' ? localNativeChatRestartStore : stores.get(target.environmentId)
  const run = store?.getNativeChatRestartRun()
  if (!run?.inFlight) {
    return false
  }
  const entry = run.entries.find(({ candidate }) => candidate.sessionId === sessionId)
  return entry !== undefined && isResumeRunPendingPhase(entry.observedStatus?.restartResume?.phase)
}

export function useNativeChatRestartRuntimes() {
  const environments = useAppStore((state) => state.runtimeEnvironments)
  const statuses = useRuntimeStatusByEnvironmentId()
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
