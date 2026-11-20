import { useCallback, useSyncExternalStore } from 'react'
import type {
  BrowserLoadStall,
  BrowserLoadStallEvent
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { useTranslate } from '@/i18n/use-translate'

// One subscription for the app, so a pane that remounts mid-stall still knows its load is stuck.
const stalls = new Map<string, { webContentsId: number; stall: BrowserLoadStall }>()
const listenersByPage = new Map<string, Set<() => void>>()
let stopListening: (() => void) | null = null

/** Started at app launch: retained pages can stall before any browser pane mounts. */
export function listenForBrowserLoadStalls(): () => void {
  stopListening ??= window.api?.browser?.onLoadStall?.(applyLoadStallEvent) ?? (() => {})
  return () => {
    stopListening?.()
    stopListening = null
  }
}

function applyLoadStallEvent(event: BrowserLoadStallEvent): void {
  if (event.stall) {
    stalls.set(event.browserPageId, { webContentsId: event.webContentsId, stall: event.stall })
  } else if (stalls.get(event.browserPageId)?.webContentsId === event.webContentsId) {
    stalls.delete(event.browserPageId)
  } else {
    // A replaced guest's clear must not remove its successor's stall.
    return
  }
  for (const notify of listenersByPage.get(event.browserPageId) ?? []) {
    notify()
  }
}

function subscribe(browserPageId: string, listener: () => void): () => void {
  let listeners = listenersByPage.get(browserPageId)
  if (!listeners) {
    listeners = new Set()
    listenersByPage.set(browserPageId, listeners)
  }
  listeners.add(listener)
  listenForBrowserLoadStalls()
  return () => {
    const current = listenersByPage.get(browserPageId)
    current?.delete(listener)
    if (current?.size === 0) {
      listenersByPage.delete(browserPageId)
    }
  }
}

/** Status-bubble text for a page load that hasn't committed after a few seconds. */
export function useBrowserLoadStallStatus(browserPageId: string): string | null {
  const t = useTranslate()
  const subscribeToPage = useCallback(
    (listener: () => void) => subscribe(browserPageId, listener),
    [browserPageId]
  )
  const stall = useSyncExternalStore(
    subscribeToPage,
    () => stalls.get(browserPageId)?.stall ?? null,
    () => null
  )
  if (!stall) {
    return null
  }
  // States the background tabs as a fact: Orca can't see which pages hold the site's connections.
  return stall.hiddenSameOriginPages > 0
    ? t(
        'browser.loadStall.waitingWithBackgroundTabs',
        'Waiting for {{host}}… {{count}} other tabs on this site are open in the background.',
        {
          host: stall.host,
          count: stall.hiddenSameOriginPages,
          defaultValue_one:
            'Waiting for {{host}}… 1 other tab on this site is open in the background.'
        }
      )
    : t('browser.loadStall.waitingForHost', 'Waiting for {{host}}…', { host: stall.host })
}
