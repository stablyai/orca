import {
  isBrowserPageMobileDriven,
  onBrowserDriverChange
} from '../../../../runtime/browser/ownership/browser-mobile-driver-store'
import {
  isBrowserPageRemotelyViewed,
  onBrowserRemoteViewerChange
} from '../../../../runtime/browser/ownership/browser-remote-viewer-store'
import {
  isBrowserAutomationVisible,
  onBrowserAutomationVisibilityChange
} from './browser-automation-visibility-store'

// Centralize all paint-retention terms so new signals cannot silently miss a container gate.
export function browserPageNeedsPaintRetention(browserPageId: string): boolean {
  return (
    isBrowserAutomationVisible(browserPageId) ||
    isBrowserPageMobileDriven(browserPageId) ||
    isBrowserPageRemotelyViewed(browserPageId)
  )
}

/** Fires whenever any retention term flips, for callers that cache a retention decision. */
export function onBrowserGuestPaintRetentionChange(listener: (pageId: string) => void): () => void {
  const removeListeners = [
    onBrowserAutomationVisibilityChange(listener),
    onBrowserDriverChange((event) => listener(event.browserPageId)),
    onBrowserRemoteViewerChange(listener)
  ]
  return () => {
    for (const removeListener of removeListeners) {
      removeListener()
    }
  }
}
