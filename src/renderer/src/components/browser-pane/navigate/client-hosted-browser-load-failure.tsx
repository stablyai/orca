import { useAppStore } from '@/store'
import type { BrowserPage as BrowserPageState } from '../../../../../shared/browser/workspaces/browser-workspace-types'
import { BrowserLoadFailureOverlay } from './browser-load-failure-overlay'
import {
  getRemoteRoutedOpenableExternalUrl,
  toDisplayUrl
} from '../describe-page/browser-page-url-display'

/** A client-hosted page's failure page; its Retry and auto-retry re-attempt the load in the local guest. */
export function ClientHostedBrowserLoadFailure({
  browserTab,
  isActive,
  onRetry
}: {
  browserTab: BrowserPageState
  isActive: boolean
  onRetry: () => void
}): React.JSX.Element | null {
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  if (!browserTab.loadError) {
    return null
  }
  // Why: name the URL that failed, not the page still loaded behind it.
  const failedNavigationUrl = browserTab.loadError.validatedUrl ?? toDisplayUrl(browserTab.url)
  return (
    <BrowserLoadFailureOverlay
      loadError={browserTab.loadError}
      onRetry={onRetry}
      autoRetry={{ active: isActive, loading: browserTab.loading }}
      onOpenExternal={(url) => void window.api.shell.openUrl(url)}
      // The page browses through the server, so its loopback is the server's, not this desktop's.
      externalUrl={getRemoteRoutedOpenableExternalUrl(failedNavigationUrl)}
      certificateFailure={certificateFailure}
      expectedBrowserPageId={browserTab.id}
      // This desktop owns the guest session, so certificate decisions use the same local IPC as local browser panes.
      onProceedCertificate={(challengeId) =>
        window.api.browser.proceedCertificate({
          browserPageId: browserTab.id,
          challengeId
        })
      }
    />
  )
}
