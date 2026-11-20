import { useSyncExternalStore } from 'react'

let present = false
const listeners = new Set<() => void>()

/** Set by the list root's ref callback, so the rail never points aria-controls at a list that isn't there. */
export function setWorkspaceListRegionPresent(next: boolean): void {
  if (next === present) {
    return
  }
  present = next
  for (const listener of listeners) {
    listener()
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getPresent = (): boolean => present

export function useWorkspaceListRegionPresent(): boolean {
  return useSyncExternalStore(subscribe, getPresent, getPresent)
}
