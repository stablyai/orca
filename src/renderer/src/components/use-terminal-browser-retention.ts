import { useEffect } from 'react'
import { onBrowserGuestPaintRetentionChange } from './browser-pane/host-guest/browser-guest-paint-retention'
import { browserPageVetoesGuestEviction } from './browser-pane/host-guest/browser-guest-eviction-veto'
import { installBrowserPageDownloadActivityTracking } from './browser-pane/navigate/browser-page-download-activity'
import {
  touchBrowserGuestActivity,
  invalidateBrowserGuestActivity,
  updateBrowserGuestProtection
} from './browser-pane/host-guest/browser-guest-activity'
import { installBrowserGuestPageRetention } from './browser-pane/host-guest/browser-guest-page-retention'
import { destroyRemovedBrowserWebview } from '../store/slices/browser/cleanup/browser-webview-cleanup'
import type { TerminalParkingFoundation } from './use-terminal-parking-foundation'

export function useTerminalBrowserRetention({
  browserGuestRetentionBudgetEnabled
}: Pick<TerminalParkingFoundation, 'browserGuestRetentionBudgetEnabled'>): void {
  useEffect(() => {
    const removeDownloadTracking = installBrowserPageDownloadActivityTracking(
      invalidateBrowserGuestActivity
    )
    const removePaintTracking = onBrowserGuestPaintRetentionChange(touchBrowserGuestActivity)
    const removeProtectionTracking = window.api.browser.onGuestDiscardProtectionChanged(
      updateBrowserGuestProtection
    )
    const removeAudioTracking = window.api.browser.onAudioStateChanged(({ browserPageId }) =>
      invalidateBrowserGuestActivity(browserPageId)
    )
    return () => {
      removeDownloadTracking()
      removePaintTracking()
      removeProtectionTracking()
      removeAudioTracking()
    }
  }, [])

  useEffect(() => {
    if (!browserGuestRetentionBudgetEnabled) {
      return
    }
    return installBrowserGuestPageRetention({
      isBlocked: browserPageVetoesGuestEviction,
      getProtection: (browserPageId, webContentsId) =>
        window.api.browser.getGuestDiscardProtection({ browserPageId, webContentsId }),
      destroy: destroyRemovedBrowserWebview
    })
  }, [browserGuestRetentionBudgetEnabled])
}
