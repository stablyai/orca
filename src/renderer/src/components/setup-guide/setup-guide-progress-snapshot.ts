import { useSyncExternalStore } from 'react'
export type SetupGuideProgressSnapshot = {
  ready: boolean
  done: number
  total: number
}

let snapshot: SetupGuideProgressSnapshot | null = null
const listeners = new Set<() => void>()

/** Published by the app-level setup observer; replaced only when a value changes so readers don't re-render. */
export function publishSetupGuideProgress(next: SetupGuideProgressSnapshot | null): void {
  if (
    next === snapshot ||
    (next &&
      snapshot &&
      next.ready === snapshot.ready &&
      next.done === snapshot.done &&
      next.total === snapshot.total)
  ) {
    return
  }
  snapshot = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getSnapshot = (): SetupGuideProgressSnapshot | null => snapshot

/** Latest setup progress, or null while unknown. Reading it starts no setup checks. */
export function useSetupGuideProgressSnapshot(): SetupGuideProgressSnapshot | null {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
