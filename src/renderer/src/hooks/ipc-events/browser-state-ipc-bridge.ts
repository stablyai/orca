import { rememberLiveBrowserUrl } from '@/components/browser-pane/describe-page/live-browser-url-registry'
import { runtimeEnvironmentIdOrLocalUnlessTwin } from '@/lib/worktree-runtime-owner'
import { findVisibleBrowserLinkTarget } from '@/lib/visible-browser-link-target'
import { openUrlInTabBesideBrowserPage } from '@/lib/browser-page-tab-opening'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import { useAppStore } from '../../store'
import { findPage } from '../../store/slices/browser-page-records'
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
import {
  setBrowserAgentPageActive,
  showBrowserAgentCursor
} from '@/components/browser-pane/agent-cursor/browser-agent-activity-state'

/** Client-hosted webview events originate in this desktop even for remote workspaces; runtime-active guards would incorrectly drop them. */
function isClientHostedBrowserPage(browserPageId: string): boolean {
  return (
    useAppStore.getState().remoteBrowserPageHandlesByPageId[browserPageId]?.placement?.kind ===
    'client'
  )
}

/** One automation-visibility lease per page while main reports it held; repeats are ignored. */
function createMainOwnedPaintHolds(): {
  set: (browserPageId: string, held: boolean) => void
  releaseAll: () => void
} {
  const tokens = new Map<string, string>()
  return {
    set: (browserPageId, held) => {
      const token = tokens.get(browserPageId)
      if (held && !token) {
        tokens.set(browserPageId, acquireBrowserAutomationVisibility(browserPageId))
      } else if (!held && token) {
        tokens.delete(browserPageId)
        releaseBrowserAutomationVisibility(token)
      }
    },
    // A dead hold cannot release later; clear it now so the page cannot remain drawn indefinitely.
    releaseAll: () => {
      for (const token of tokens.values()) {
        releaseBrowserAutomationVisibility(token)
      }
      tokens.clear()
    }
  }
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
  // Why no runtime guard: only guests in this process report, and streamed pages have none here.
  const unsubscribeAudioState = window.api.browser.onAudioStateChanged?.(
    ({ browserPageId, audible }) => {
      const store = useAppStore.getState()
      store.setBrowserPageAudible(browserPageId, audible)
      // Why: main reports each newly registered guest, and a new guest (eviction, crash) starts unmuted.
      const tabId = findPage(store.browserPagesByWorkspace, browserPageId)?.workspaceId
      if (tabId && store.browserAudioMutedTabIds[tabId]) {
        void window.api.browser.setPageAudioMuted({ browserPageId, muted: true })
      }
    }
  )
  if (unsubscribeAudioState) {
    unsubs.push(unsubscribeAudioState)
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
  const capturePaintHolds = createMainOwnedPaintHolds()
  const unsubscribeCapturePaintHold = window.api.browser.onCapturePaintHold?.(
    ({ browserPageId, held }) => capturePaintHolds.set(browserPageId, held)
  )
  if (unsubscribeCapturePaintHold) {
    unsubs.push(() => {
      unsubscribeCapturePaintHold()
      capturePaintHolds.releaseAll()
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
  // Why: the bootstrap lease is fixed at creation; an agent's page in a hidden worktree must keep drawing while it drives it.
  const agentActivityPaintHolds = createMainOwnedPaintHolds()
  const unsubscribeAgentActivity = window.api.browser.onAgentActivity?.(
    ({ browserPageId, worktreeId, active }) => {
      setBrowserAgentPageActive(browserPageId, active, worktreeId)
      agentActivityPaintHolds.set(browserPageId, active)
    }
  )
  if (unsubscribeAgentActivity) {
    unsubs.push(() => {
      unsubscribeAgentActivity()
      agentActivityPaintHolds.releaseAll()
    })
  }
  const unsubscribeAgentCursor = window.api.browser.onAgentCursor?.((event) => {
    // Main waits for this answer, so a page nobody can see answers at once.
    if (!showBrowserAgentCursor(event) && event.awaitsArrival) {
      window.api.browser.agentCursorArrived(event.sequence)
    }
  })
  if (unsubscribeAgentCursor) {
    unsubs.push(unsubscribeAgentCursor)
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
      const placement = findVisibleBrowserLinkTarget(store, sourcePage.worktreeId)
      const openedPageId = openUrlInTabBesideBrowserPage({
        sourcePageId: browserPageId,
        worktreeId: sourcePage.worktreeId,
        url,
        activate: activate ?? true,
        placement
      })
      if (openedPageId) {
        markBrowserPageOpenedByPage(openedPageId)
        if (placement && activate !== false) {
          store.focusGroup(sourcePage.worktreeId, placement.targetGroupId)
        }
      }
    })
  )
  unsubs.push(
    window.api.browser.onSessionProfilesChanged(() => {
      void useAppStore.getState().fetchBrowserSessionProfiles(LOCAL_EXECUTION_HOST_ID)
    })
  )
}
