import { useAppStore } from '@/store'
import type { BrowserPage as BrowserPageState } from '../../../../shared/browser-workspace-types'
import { toHttpsRecoveryUrl } from '../../../../shared/browser-url'
import { BrowserLoadFailureOverlay } from './navigate/browser-load-failure-overlay'
import { getOpenableExternalUrl, toDisplayUrl } from './describe-page/browser-page-url-display'

/** A client-hosted page's failure page; its Retry and auto-retry re-attempt the load in the local guest. */
export function ClientHostedBrowserLoadFailure({
  browserTab,
  isActive,
  onRetry,
  onNavigate
}: {
  browserTab: BrowserPageState
  isActive: boolean
  onRetry: () => void
  onNavigate: (url: string) => void
}): React.JSX.Element | null {
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  if (!browserTab.loadError) {
    return null
  }
  // Why: the failure is about the URL that failed, not whatever page is still loaded — feeding
  // browserTab.url here named the previous page and offered it an HTTPS retry it never needed.
  const failedNavigationUrl = browserTab.loadError.validatedUrl ?? toDisplayUrl(browserTab.url)
  return (
    <BrowserLoadFailureOverlay
      loadError={browserTab.loadError}
      currentUrl={toDisplayUrl(failedNavigationUrl)}
      httpsRecoveryUrl={toHttpsRecoveryUrl(failedNavigationUrl)}
      onRetry={onRetry}
      autoRetry={{ active: isActive, whileWindowHidden: false, loading: browserTab.loading }}
      onTryHttps={onNavigate}
      onCopy={(url) => void window.api.ui.writeClipboardText(url)}
      onOpenExternal={(url) => void window.api.shell.openUrl(url)}
      externalUrl={getOpenableExternalUrl(failedNavigationUrl)}
      certificateFailure={certificateFailure}
      expectedBrowserPageId={browserTab.id}
      // Why: the guest is a local Electron webview on this desktop, so its certificate
      // decision is a local session decision — the same IPC the local pane proceeds through.
      onProceedCertificate={(challengeId) =>
        window.api.browser.proceedCertificate({
          browserPageId: browserTab.id,
          challengeId
        })
      }
    />
  )
}
