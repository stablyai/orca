import type { BrowserGuestDiscardProtectionChange } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

export type BrowserGuestActivity = {
  webview: Electron.WebviewTag
  visible: boolean
  revision: number
  lastSelectedAt: number
  lastUsed: number
  protection?: BrowserGuestDiscardProtectionChange['protection']
}

export const browserGuestActivity = new Map<string, BrowserGuestActivity>()
export const retiredBrowserGuestResources = new Set<number>()
export function setBrowserGuestResourceRetired(
  pageId: string,
  guestId: number,
  retired: boolean
): void {
  if (retired) {
    retiredBrowserGuestResources.add(guestId)
  } else {
    retiredBrowserGuestResources.delete(guestId)
  }
  for (const listener of listeners) {
    listener(pageId)
  }
}

const listeners = new Set<(pageId: string) => void>()
let useSequence = 0

export function onBrowserGuestActivity(listener: (pageId: string) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function invalidateBrowserGuestActivity(pageId: string): void {
  const entry = browserGuestActivity.get(pageId)
  if (!entry) {
    return
  }
  entry.revision += 1
  for (const listener of listeners) {
    listener(pageId)
  }
}

export function touchBrowserGuestActivity(pageId: string): void {
  const entry = browserGuestActivity.get(pageId)
  if (!entry) {
    return
  }
  entry.lastUsed = ++useSequence
  invalidateBrowserGuestActivity(pageId)
}

export function registerBrowserGuestActivity(pageId: string, webview: Electron.WebviewTag): void {
  browserGuestActivity.set(pageId, {
    webview,
    visible: false,
    revision: 0,
    lastUsed: ++useSequence,
    lastSelectedAt: 0
  })
  touchBrowserGuestActivity(pageId)
}

export function unregisterBrowserGuestActivity(pageId: string): void {
  browserGuestActivity.delete(pageId)
  for (const listener of listeners) {
    listener(pageId)
  }
}

export function setBrowserGuestVisible(pageId: string, visible: boolean): void {
  const entry = browserGuestActivity.get(pageId)
  if (!entry || entry.visible === visible) {
    return
  }
  entry.lastSelectedAt = Date.now()
  entry.visible = visible
  touchBrowserGuestActivity(pageId)
}

export function updateBrowserGuestProtection(event: BrowserGuestDiscardProtectionChange): void {
  const entry = browserGuestActivity.get(event.browserPageId)
  if (!entry) {
    return
  }
  try {
    if (entry.webview.getWebContentsId() !== event.webContentsId) {
      return
    }
  } catch {
    return
  }
  entry.protection = event.protection
  invalidateBrowserGuestActivity(event.browserPageId)
}
