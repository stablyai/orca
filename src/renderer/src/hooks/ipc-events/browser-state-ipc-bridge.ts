import { toast } from 'sonner'
import { rememberLiveBrowserUrl } from '@/components/browser-pane/describe-page/live-browser-url-registry'
import { translate } from '@/i18n/i18n'
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
    window.api.browser.onOpenLinkInOrcaTab(({ browserPageId, url }) => {
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
      store.createBrowserTab(sourcePage.worktreeId, url, {
        title: url,
        ...(sourceTab
          ? {
              sessionProfileId: sourceTab.sessionProfileId,
              sessionPartition: sourceTab.sessionPartition
            }
          : {})
      })
    })
  )
  // Why: the doc-preview scheme is desktop-only, so hosts without it (web client) simply have no channel.
  if (typeof window.api.docPreview?.onExternalLink === 'function') {
    unsubs.push(
      window.api.docPreview.onExternalLink(({ url }) => {
        // Why: an external link in a doc preview leaves the preview entirely — it becomes a normal
        // browser tab through the same path as any other new tab, local or paired.
        // Why: the click already left the preview, so a refused tab is a dead end unless it says so.
        const reportLinkFailure = (): void => {
          toast.error(
            translate(
              'auto.hooks.ipc.events.browserStateIpcBridge.docPreviewLinkFailed',
              'Could not open this link in Orca Browser.'
            )
          )
        }
        void useAppStore
          .getState()
          .openBrowserProfileTabInActiveWorkspace(url, null)
          .then((opened) => {
            if (!opened) {
              reportLinkFailure()
            }
          })
          .catch(reportLinkFailure)
      })
    )
  }
}
