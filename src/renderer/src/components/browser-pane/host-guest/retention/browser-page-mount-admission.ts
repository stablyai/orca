import { useSyncExternalStore } from 'react'

// Start newly requested background pages once, ending admission at first load settlement/close; restored pages stay lazy and normal paint rules resume afterward.
const admittedPageIds = new Set<string>()
const listeners = new Set<() => void>()

export function isBrowserPageMountAdmitted(pageId: string): boolean {
  return admittedPageIds.has(pageId)
}

function emit(): void {
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

export function useBrowserPageMountAdmissions(pageIds: readonly string[]): string {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => pageIds.map((pageId) => (isBrowserPageMountAdmitted(pageId) ? '1' : '0')).join(''),
    () => '0'.repeat(pageIds.length)
  )
}

export function useAnyBrowserPageMountAdmission(pageIds: readonly string[]): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => pageIds.some(isBrowserPageMountAdmitted),
    () => false
  )
}
