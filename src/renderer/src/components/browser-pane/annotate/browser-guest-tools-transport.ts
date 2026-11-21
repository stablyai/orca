import type { BrowserApi } from '../../../../../preload/api/browser/browser-api'

/** Where a page's guest tools run: this window's main process, or the runtime that hosts the page. */
export type BrowserGuestToolsTransport = Pick<
  BrowserApi,
  | 'setGrabMode'
  | 'awaitGrabSelection'
  | 'cancelGrab'
  | 'captureSelectionScreenshot'
  | 'extractHoverPayload'
  | 'setAnnotationViewportBridge'
  | 'onGrabModeToggle'
  | 'onGrabActionShortcut'
>

export const ipcBrowserGuestToolsTransport: BrowserGuestToolsTransport = {
  setGrabMode: (args) => window.api.browser.setGrabMode(args),
  awaitGrabSelection: (args) => window.api.browser.awaitGrabSelection(args),
  cancelGrab: (args) => window.api.browser.cancelGrab(args),
  captureSelectionScreenshot: (args) => window.api.browser.captureSelectionScreenshot(args),
  extractHoverPayload: (args) => window.api.browser.extractHoverPayload(args),
  setAnnotationViewportBridge: (args) => window.api.browser.setAnnotationViewportBridge(args),
  // Main forwards the chords a focused local guest swallows.
  onGrabModeToggle: (callback) => window.api.browser.onGrabModeToggle(callback),
  onGrabActionShortcut: (callback) => window.api.browser.onGrabActionShortcut(callback)
}
