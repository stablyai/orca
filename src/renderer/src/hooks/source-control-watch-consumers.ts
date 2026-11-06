import { useEffect, useSyncExternalStore } from 'react'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import { WARM_RECURSIVE_WATCH_WORKSPACE_COUNT } from './editor-external-watch-scope'
const consumers = new Map<string, EditorExternalWatchTarget>()
const listeners = new Set<() => void>()
let snapshot: readonly EditorExternalWatchTarget[] = []
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getSnapshot = () => snapshot
function publish() {
  snapshot = [...consumers.values()].slice(0, WARM_RECURSIVE_WATCH_WORKSPACE_COUNT)
  for (const listener of listeners) {
    listener()
  }
}
export function useSourceControlWatchConsumers() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
export function useSourceControlWatchConsumer(
  key: string,
  target: EditorExternalWatchTarget | null
): void {
  const path = target?.worktreePath
  const id = target?.worktreeId
  const connection = target?.connectionId
  const runtime = target?.runtimeEnvironmentId
  useEffect(() => {
    if (!id || !path) {
      return
    }
    consumers.set(key, {
      worktreeId: id,
      worktreePath: path,
      connectionId: connection,
      runtimeEnvironmentId: runtime ?? null
    })
    publish()
    return () => {
      consumers.delete(key)
      publish()
    }
  }, [key, id, path, connection, runtime])
}
