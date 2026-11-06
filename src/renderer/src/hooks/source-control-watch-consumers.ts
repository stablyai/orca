import { useEffect, useSyncExternalStore } from 'react'
import type { EditorExternalWatchTarget } from './editor-external-watch-targets'
import { WARM_RECURSIVE_WATCH_WORKSPACE_COUNT } from './editor-external-watch-scope'
const consumers = new Map<string, { target: EditorExternalWatchTarget; expandedAt: number }>()
const listeners = new Set<() => void>()
let snapshot: readonly EditorExternalWatchTarget[] = []
let expansionSequence = 0
const subscribe = (listener: () => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
const getSnapshot = () => snapshot
function publish() {
  // Why most recent first: the sections the user just opened get the existing warm-watch slots.
  const next = [...consumers.values()]
    .sort((left, right) => right.expandedAt - left.expandedAt)
    .slice(0, WARM_RECURSIVE_WATCH_WORKSPACE_COUNT)
    .map((consumer) => consumer.target)
  if (
    next.length === snapshot.length &&
    next.every((target, index) => target === snapshot[index])
  ) {
    return
  }
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}
/** Stamp for a user's expansion; auto-expanded sections use 0 and rank behind every user expansion. */
export function nextSourceControlExpansionStamp(): number {
  expansionSequence += 1
  return expansionSequence
}
export function useSourceControlWatchConsumers() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
export function useSourceControlWatchConsumer(
  key: string,
  target: EditorExternalWatchTarget | null,
  expandedAt: number
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
      target: {
        worktreeId: id,
        worktreePath: path,
        connectionId: connection,
        runtimeEnvironmentId: runtime ?? null
      },
      expandedAt
    })
    publish()
    return () => {
      consumers.delete(key)
      publish()
    }
  }, [key, id, path, connection, runtime, expandedAt])
}
