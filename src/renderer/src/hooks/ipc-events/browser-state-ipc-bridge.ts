import { toast } from 'sonner'
import type { BrowserOpenLinkEvent } from '../../../../shared/browser-open-link-event'
import { rememberLiveBrowserUrl } from '@/components/browser-pane/describe-page/live-browser-url-registry'
import { getBrowserPageRuntimeEnvironmentId } from '@/components/browser-pane/describe-page/browser-page-url-display'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { redactKagiSessionToken } from '../../../../shared/browser-url'
import { useAppStore } from '../../store'
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
    window.api.browser.onOpenLinkInOrcaTab((event) => {
      void openBrowserLink(event).catch((error) =>
        toast.error(error instanceof Error ? error.message : String(error))
      )
    })
  )
}

async function openBrowserLink({
  browserPageId,
  url,
  activate,
  owner,
  childBrowserPageId
}: BrowserOpenLinkEvent): Promise<void> {
  const store = useAppStore.getState()
  const sourcePage = Object.values(store.browserPagesByWorkspace)
    .flat()
    .find((page) => page.id === browserPageId)
  const worktreeId = owner?.worktreeId ?? sourcePage?.worktreeId
  if (!worktreeId) {
    throw new Error('The browser link owner is no longer available.')
  }
  const workspaceId = owner?.workspaceId ?? sourcePage?.workspaceId
  const sourceTab = (store.browserTabsByWorktree[worktreeId] ?? []).find(
    (tab) => tab.id === workspaceId
  )
  const sessionProfileId = owner ? owner.sessionProfileId : sourceTab?.sessionProfileId
  if (sessionProfileId === undefined) {
    throw new Error('The browser link profile is no longer available.')
  }
  const environmentId =
    store.remoteBrowserPageHandlesByPageId?.[browserPageId]?.environmentId ??
    (sourcePage
      ? getBrowserPageRuntimeEnvironmentId(
          sourcePage,
          getRuntimeEnvironmentIdForWorktree(store, worktreeId)
        )
      : getRuntimeEnvironmentIdForWorktree(store, worktreeId))
  if (environmentId) {
    const { createWebRuntimeSessionBrowserTab } = await import('@/runtime/web-runtime-session')
    const created = await createWebRuntimeSessionBrowserTab({
      worktreeId,
      environmentId,
      url,
      profileId: sessionProfileId,
      focusOnCreate: activate ?? true,
      selectWorktree: false,
      placementPreference: 'auto'
    })
    if (!created) {
      throw new Error('The owning runtime could not open the browser link.')
    }
    return
  }
  store.createBrowserTab(worktreeId, childBrowserPageId ? 'about:blank' : url, {
    title: url,
    activate: activate ?? true,
    browserPageId: childBrowserPageId,
    sessionProfileId,
    ...(sourceTab?.sessionProfileId === sessionProfileId
      ? { sessionPartition: sourceTab.sessionPartition }
      : {})
  })
}
