import { useCallback, useSyncExternalStore } from 'react'
import type {
  BrowserLoadStall,
  BrowserLoadStallEvent
} from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { useTranslate } from '@/i18n/use-translate'

// Chromium's per-host HTTP/1.1 socket limit: fewer hidden pages than this can't fill the pool alone.
const SOCKETS_PER_HOST = 6

// One subscription for the app, so a pane that remounts mid-stall still knows its load is stuck.
const stalls = new Map<string, { webContentsId: number; stall: BrowserLoadStall }>()
const listenersByPage = new Map<string, Set<() => void>>()
let listening = false

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
  if (!listening) {
    listening = true
    window.api?.browser?.onLoadStall?.(applyLoadStallEvent)
  }
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
  // HTTPS sites usually share one HTTP/2 connection, so the pool is named only for plain HTTP.
  return stall.scheme === 'http' && stall.hiddenSameOriginPages >= SOCKETS_PER_HOST
    ? t(
        'browser.loadStall.waitingForConnection',
        'Waiting for a free connection to {{host}}. {{pages}} hidden tabs on this site may be holding them.',
        { host: stall.host, pages: stall.hiddenSameOriginPages }
      )
    : t('browser.loadStall.waitingForHost', 'Waiting for {{host}}…', { host: stall.host })
}
