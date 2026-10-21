import type {
  BrowserCertificateFailure,
  BrowserPage
} from '../../../../shared/browser-workspace-types'
import { toHttpsRecoveryUrl } from '../../../../shared/browser-url'
import { toDisplayUrl } from './describe-page/browser-page-url-display'
import { BrowserLoadFailureOverlay } from './navigate/browser-load-failure-overlay'

export function ClientHostedBrowserLoadFailure({
  visible,
  browserTab,
  failedNavigationUrl,
  certificateFailure,
  onRetry,
  navigateToUrl
}: {
  visible: boolean
  browserTab: BrowserPage
  failedNavigationUrl: string
  certificateFailure: BrowserCertificateFailure | null
  onRetry: () => void
  navigateToUrl: (url: string) => void
}): React.JSX.Element | null {
  return visible && browserTab.loadError ? (
    <BrowserLoadFailureOverlay
      loadError={browserTab.loadError}
      currentUrl={toDisplayUrl(failedNavigationUrl)}
      httpsRecoveryUrl={toHttpsRecoveryUrl(failedNavigationUrl)}
      onRetry={() => onRetry()}
      onTryHttps={navigateToUrl}
      onCopy={(url) => void window.api.ui.writeClipboardText(url)}
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
  ) : null
}
