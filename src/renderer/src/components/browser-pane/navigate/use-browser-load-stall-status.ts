import { useCallback, useSyncExternalStore } from 'react'
import type { BrowserLoadStallEvent } from '../../../../../shared/browser/guest-lifecycle/browser-guest-events'
import { useTranslate } from '@/i18n/use-translate'

// One subscription for the app, so a pane that remounts mid-stall still knows its load is stuck.
const stalls = new Map<
  string,
  { webContentsId: number; stall: NonNullable<BrowserLoadStallEvent['stall']> }
>()
const listenersByPage = new Map<string, Set<() => void>>()
let stopListening: (() => void) | null = null

/** Started at app launch: retained pages can stall before any browser pane mounts. */
export function listenForBrowserLoadStalls(): () => void {
  stopListening ??= window.api?.browser?.onLoadStall?.(applyLoadStallEvent) ?? (() => {})
  return () => {
    stopListening?.()
    stopListening = null
    // Clears sent while unsubscribed would be missed; drop every cached stall rather than keep it.
    const pages = [...stalls.keys()]
    stalls.clear()
    for (const browserPageId of pages) {
      for (const notify of listenersByPage.get(browserPageId) ?? []) {
        notify()
      }
    }
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
  // Like a browser's status bubble: the host only; the stuck phase and background tabs go to the trace.
  return t('browser.loadStall.waitingForHost', 'Waiting for {{host}}…', { host: stall.host })
}
