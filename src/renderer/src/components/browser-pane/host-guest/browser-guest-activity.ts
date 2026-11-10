import type { BrowserGuestDiscardProtectionChange } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

export type BrowserGuestActivity = {
  webview: Electron.WebviewTag
  visible: boolean
  revision: number
  lastUsed: number
  protection?: BrowserGuestDiscardProtectionChange['protection']
}

export const browserGuestActivity = new Map<string, BrowserGuestActivity>()
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
  browserGuestActivity.set(pageId, { webview, visible: true, revision: 0, lastUsed: ++useSequence })
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
