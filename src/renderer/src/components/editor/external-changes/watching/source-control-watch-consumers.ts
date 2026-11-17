import { useEffect, useSyncExternalStore } from 'react'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
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
let publishQueued = false
// Why no cap: every mounted section is a displayed repository model, like the reference's per-repository watcher.
// Why a microtask: a panel mounting N sections recomputes watch targets once, not N times.
function publish() {
  if (publishQueued) {
    return
  }
  publishQueued = true
  queueMicrotask(() => {
    publishQueued = false
    snapshot = [...consumers.values()]
    for (const listener of listeners) {
      listener()
    }
  })
}
/** Folder Source Control sections' watch targets, unioned outside the ordinary warm-workspace budget. */
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
