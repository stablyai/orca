import { useSyncExternalStore } from 'react'

// Start newly requested background pages once, ending admission at first load settlement/close; restored pages stay lazy and normal paint rules resume afterward.
const admittedPageIds = new Set<string>()
const listeners = new Set<() => void>()
let version = 0

export function isBrowserPageMountAdmitted(pageId: string): boolean {
  return admittedPageIds.has(pageId)
}

function emit(): void {
  version += 1
  for (const listener of listeners) {
    listener()
  }
}

export function admitBrowserPageMount(pageId: string): void {
  if (admittedPageIds.has(pageId)) {
    return
  }
  admittedPageIds.add(pageId)
  emit()
}

export function releaseBrowserPageMount(pageId: string): void {
  if (!admittedPageIds.delete(pageId)) {
    return
  }
  emit()
}

export function useAnyBrowserPageMountAdmission(pageIds: readonly string[]): boolean {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => {
      void version
      return pageIds.some(isBrowserPageMountAdmitted)
    },
    () => false
  )
  return pageIds.some(isBrowserPageMountAdmitted)
}
