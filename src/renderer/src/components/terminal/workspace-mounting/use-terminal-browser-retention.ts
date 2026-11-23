import { useEffect } from 'react'
import { onBrowserGuestPaintRetentionChange } from '../../browser-pane/host-guest/retention/browser-page-paint-retention-terms'
import { browserPageVetoesGuestEviction } from '../../browser-pane/host-guest/retention/browser-guest-eviction-veto'
import { installBrowserPageDownloadActivityTracking } from '../../browser-pane/navigate/browser-page-download-activity'
import {
  touchBrowserGuestActivity,
  invalidateBrowserGuestActivity,
  updateBrowserGuestProtection
} from '../../browser-pane/host-guest/browser-guest-activity'
import { installBrowserGuestPageRetention } from '../../browser-pane/host-guest/browser-guest-page-retention'
import { discardPersistentWebview } from '../../browser-pane/host-guest/webview-registry'
import { releaseBrowserPageMount } from '../../browser-pane/host-guest/retention/browser-page-mount-admission'

export function useTerminalBrowserRetention(): void {
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
    return installBrowserGuestPageRetention({
      isBlocked: browserPageVetoesGuestEviction,
      discard: (pageId, webview, webContentsId, policyToken) => {
        const discarded = discardPersistentWebview(pageId, webview, webContentsId, policyToken)
        if (discarded) {
          releaseBrowserPageMount(pageId)
        }
        return discarded
      }
    })
  }, [])
}
