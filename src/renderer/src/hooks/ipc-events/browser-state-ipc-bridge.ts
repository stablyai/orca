import { rememberLiveBrowserUrl } from '@/components/browser-pane/describe-page/live-browser-url-registry'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { openUrlInTabBesideBrowserPage } from '@/lib/browser-page-tab-opening'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useAppStore } from '../../store'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from '@/components/browser-pane/host-guest/browser-automation-visibility'
import { acquireBrowserAutomationBootstrapLease } from './browser-automation-bootstrap-lease'
import { markBrowserPageOpenedByPage } from '@/components/browser-pane/host-guest/browser-page-window-close'
import {
  beginAgentInputFocusGuard,
  clearAgentInputFocusGuards,
  endAgentInputFocusGuard,
  watchUserComposition
} from '@/components/browser-pane/host-guest/agent-input-focus-guard'

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
  const unsubscribeAgentInputFocusGuard = window.api.browser.onAgentInputFocusGuard?.(
    ({ browserPageId, token, active }) => {
      if (active) {
        const answer = beginAgentInputFocusGuard(browserPageId, token)
        window.api.browser.agentInputFocusGuardReady(token, answer === 'composing')
      } else {
        endAgentInputFocusGuard(token)
      }
    }
  )
  if (unsubscribeAgentInputFocusGuard) {
    const unwatchUserComposition = watchUserComposition()
    unsubs.push(() => {
      unsubscribeAgentInputFocusGuard()
      unwatchUserComposition()
      clearAgentInputFocusGuards()
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
      if (!sourcePage || runtimeEnvironmentIdOrLocalUnlessTwin(store, sourcePage.worktreeId)) {
        return
      }
      const openedPageId = openUrlInTabBesideBrowserPage({
        sourcePageId: browserPageId,
        worktreeId: sourcePage.worktreeId,
        url,
        activate: activate ?? true
      })
      if (openedPageId) {
        markBrowserPageOpenedByPage(openedPageId)
      }
    })
  )
  unsubs.push(
    window.api.browser.onSessionProfilesChanged(() => {
      void useAppStore.getState().fetchBrowserSessionProfiles(LOCAL_EXECUTION_HOST_ID)
    })
  )
}
