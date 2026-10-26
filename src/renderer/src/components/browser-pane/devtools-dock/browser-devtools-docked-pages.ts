import { useSyncExternalStore } from 'react'
import { useAppStore } from '@/store'
import { browserDevToolsDockFraction } from '../../../../../shared/browser-devtools-dock'

// Why module state: main reports dock changes for pages whose chrome may be unmounted
// (worktree switched away), and the chrome must still know on remount.
const dockedPageIds = new Set<string>()
const listeners = new Set<() => void>()
let unsubscribeMain: (() => void) | null = null

function subscribe(listener: () => void): () => void {
  unsubscribeMain ??= window.api.browser.onDevToolsDockChanged(({ browserPageId, docked }) => {
    if (docked === dockedPageIds.has(browserPageId)) {
      return
    }
    if (docked) {
      dockedPageIds.add(browserPageId)
    } else {
      dockedPageIds.delete(browserPageId)
    }
    for (const notify of Array.from(listeners)) {
      notify()
    }
  })
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Flex for the page box while its DevTools are docked beside it; null when they aren't. */
export function useBrowserDevToolsDockPageFlex(browserPageId: string): string | null {
  const docked = useSyncExternalStore(subscribe, () => dockedPageIds.has(browserPageId))
  const fraction = useAppStore((s) => browserDevToolsDockFraction(s.browserDevToolsDock))
  return docked ? `${1 - fraction} 1 0%` : null
}
