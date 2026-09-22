import { useSyncExternalStore } from 'react'

// Newly requested pages must start a guest even when opened in the background. Restored pages are
// deliberately absent so worktree restoration can remain lazy.
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

export function useBrowserPageMountAdmission(pageId: string): boolean {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => {
      void version
      return isBrowserPageMountAdmitted(pageId)
    },
    () => false
  )
  return isBrowserPageMountAdmitted(pageId)
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
