import type { BrowserGuestDiscardProtectionChange } from '../../../../../shared/browser/guest-lifecycle/browser-guest-discard-protection'

export type BrowserGuestActivity = {
  webview: Electron.WebviewTag
  visible: boolean | null
  visibilityGeneration: number
  revision: number
  protection?: BrowserGuestDiscardProtectionChange['protection']
}

export const browserGuestActivity = new Map<string, BrowserGuestActivity>()
const listeners = new Set<(pageId: string) => void>()
let visibilityGeneration = 0

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
  invalidateBrowserGuestActivity(pageId)
}

export function registerBrowserGuestActivity(pageId: string, webview: Electron.WebviewTag): void {
  browserGuestActivity.set(pageId, {
    webview,
    visible: null,
    visibilityGeneration: ++visibilityGeneration,
    revision: 0
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
  entry.visible = visible
  entry.visibilityGeneration = ++visibilityGeneration
  reportBrowserGuestVisibility(pageId)
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

export function reportBrowserGuestVisibility(pageId: string): void {
  const entry = browserGuestActivity.get(pageId)
  if (!entry || typeof window === 'undefined') {
    return
  }
  try {
    window.api?.browser.reportGuestVisibility?.({
      browserPageId: pageId,
      webContentsId: entry.webview.getWebContentsId(),
      generation: entry.visibilityGeneration,
      visible: entry.visible
    })
  } catch {
    // Registration will report again when the native identity is available.
  }
}
