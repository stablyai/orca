import { rememberLiveBrowserUrl } from '@/components/browser-pane/describe-page/live-browser-url-registry'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { findVisibleBrowserLinkTarget } from '@/lib/visible-browser-link-target'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import { useAppStore } from '../../store'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '@/components/browser-pane/host-guest/browser-automation-visibility'
import { acquireBrowserAutomationBootstrapLease } from './browser-automation-bootstrap-lease'

/**
 * A client-hosted page is a local Electron webview on this desktop that happens to belong to a
 * remote runtime. Its guest events come from this main process, not from the host's tab sync, so
 * the blanket runtime-active guard on those channels would drop them on the floor.
 */
function isClientHostedBrowserPage(browserPageId: string): boolean {
  return (
    useAppStore.getState().remoteBrowserPageHandlesByPageId[browserPageId]?.placement?.kind ===
    'client'
  )
}

export function registerBrowserStateIpcBridge(
  unsubs: (() => void)[],
  isRuntimeEnvironmentActive: () => boolean
): void {
  unsubs.push(
    window.api.ui.onFullscreenChanged((isFullScreen) => {
      useAppStore.getState().setIsFullScreen(isFullScreen)
    })
  )
  unsubs.push(
    window.api.browser.onGuestLoadFailed(({ browserPageId, loadError }) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      useAppStore.getState().updateBrowserPageState(browserPageId, {
        loading: false,
        loadError,
        canGoBack: false,
        canGoForward: false
      })
    })
  )
  const unsubscribeCertificateFailure = window.api.browser.onCertificateFailureChanged?.(
    ({ browserPageId, failure }) => {
      if (isRuntimeEnvironmentActive() && !isClientHostedBrowserPage(browserPageId)) {
        return
      }
      useAppStore.getState().setBrowserPageCertificateFailure(browserPageId, failure)
    }
  )
  if (unsubscribeCertificateFailure) {
    unsubs.push(unsubscribeCertificateFailure)
  }
  unsubs.push(
    window.api.browser.onNavigationUpdate(({ browserPageId, url, title }) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      const store = useAppStore.getState()
      // The redacted live registry must precede the raw persisted store update.
      rememberLiveBrowserUrl(browserPageId, redactKagiSessionToken(url))
      store.setBrowserPageUrl(browserPageId, url)
      store.updateBrowserPageState(browserPageId, { title, loading: false })
    })
  )
  unsubs.push(
    window.api.browser.onActivateView(({ worktreeId, browserPageId }) => {
      if (!isRuntimeEnvironmentActive()) {
        acquireBrowserAutomationBootstrapLease(worktreeId, browserPageId)
      }
    })
  )
  // Why: main owns capture holds and sends each page's first hold and last release; no reply is awaited.
  const capturePaintHoldTokens = new Map<string, string>()
  const unsubscribeCapturePaintHold = window.api.browser.onCapturePaintHold?.(
    ({ browserPageId, held }) => {
      const token = capturePaintHoldTokens.get(browserPageId)
      if (held && !token) {
        capturePaintHoldTokens.set(browserPageId, acquireBrowserAutomationVisibility(browserPageId))
      } else if (!held && token) {
        capturePaintHoldTokens.delete(browserPageId)
        releaseBrowserAutomationVisibility(token)
      }
    }
  )
  if (unsubscribeCapturePaintHold) {
    unsubs.push(() => {
      unsubscribeCapturePaintHold()
      // Why: the release for a live hold can no longer arrive, so it must not leave the page drawn.
      for (const token of capturePaintHoldTokens.values()) {
        releaseBrowserAutomationVisibility(token)
      }
      capturePaintHoldTokens.clear()
    })
  }
  unsubs.push(
    window.api.browser.onPaneFocus(({ worktreeId, browserPageId }) => {
      if (isRuntimeEnvironmentActive()) {
        return
      }
      const store = useAppStore.getState()
      const targetWorktreeId = worktreeId ?? store.activeWorktreeId
      if (targetWorktreeId) {
        store.focusBrowserTabInWorktree(targetWorktreeId, browserPageId)
      }
    })
  )
  unsubs.push(
    window.api.browser.onOpenLinkInOrcaTab(({ browserPageId, url, activate }) => {
      const store = useAppStore.getState()
      const sourcePage = Object.values(store.browserPagesByWorkspace)
        .flat()
        .find((page) => page.id === browserPageId)
      if (!sourcePage || getRuntimeEnvironmentIdForWorktree(store, sourcePage.worktreeId)) {
        return
      }
      // Why: the link inherits the opener's cookie jar. Falling back to the default profile would let
      // a page in an isolated session hand its links to the default one, silently crossing profiles.
      const sourceTab = (store.browserTabsByWorktree[sourcePage.worktreeId] ?? []).find(
        (tab) => tab.id === sourcePage.workspaceId
      )
      const placement = findVisibleBrowserLinkTarget(store, sourcePage.worktreeId)
      const shouldActivate = activate ?? true
      store.createBrowserTab(sourcePage.worktreeId, url, {
        title: url,
        activate: shouldActivate,
        ...placement,
        ...(sourceTab
          ? {
              sessionProfileId: sourceTab.sessionProfileId,
              sessionPartition: sourceTab.sessionPartition
            }
          : {})
      })
      if (placement && shouldActivate) {
        store.focusGroup(sourcePage.worktreeId, placement.targetGroupId)
      }
    })
  )
}
