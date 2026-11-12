import { useAppStore } from '@/store'
import type { BrowserPage as BrowserPageState } from '../../../../shared/browser-workspace-types'
import { BrowserLoadFailureOverlay } from './navigate/browser-load-failure-overlay'
import { getOpenableExternalUrl, toDisplayUrl } from './describe-page/browser-page-url-display'
import { isOrcaCloudEnvironmentId } from '@/lib/orca-cloud/orca-cloud-environment-id'
import { useSetupScriptAsleepCloud } from '../sidebar/use-setup-script-asleep-cloud'
import {
  describeSandboxUnreachableSite,
  SandboxUnreachableSiteState
} from './sandbox-unreachable-site-state'

/** A client-hosted page's failure page; its Retry and auto-retry re-attempt the load in the local guest. */
export function ClientHostedBrowserLoadFailure({
  shown,
  browserTab,
  isActive,
  onRetry,
  runtimeEnvironmentId
}: {
  /** False while the pane shows its unavailable notice instead (or there is no failure). */
  shown: boolean
  browserTab: BrowserPageState
  isActive: boolean
  onRetry: () => void
  runtimeEnvironmentId: string
}): React.JSX.Element | null {
  const certificateFailure = useAppStore(
    (s) => s.browserCertificateFailuresByPageId[browserTab.id] ?? null
  )
  const sandboxNotAwake = useSetupScriptAsleepCloud(browserTab.worktreeId)
  if (!shown || !browserTab.loadError) {
    return null
  }
  // Why: name the URL that failed, not the page still loaded behind it.
  const failedNavigationUrl = browserTab.loadError.validatedUrl ?? toDisplayUrl(browserTab.url)
  // Orca Cloud pages browse through the sandbox, whose egress only reaches approved hosts.
  const sandboxSite = isOrcaCloudEnvironmentId(runtimeEnvironmentId)
    ? describeSandboxUnreachableSite(browserTab.loadError, failedNavigationUrl)
    : null
  if (sandboxSite) {
    return (
      <SandboxUnreachableSiteState
        site={sandboxSite}
        errorName={browserTab.loadError.description || null}
        onOpenInBrowser={(url) => void window.api.shell.openUrl(url)}
        onRetry={onRetry}
        isActive={isActive}
        sandboxAwake={!sandboxNotAwake}
      />
    )
  }
  return (
    <BrowserLoadFailureOverlay
      loadError={browserTab.loadError}
      onRetry={onRetry}
      autoRetry={{ active: isActive, loading: browserTab.loading }}
      onOpenExternal={(url) => void window.api.shell.openUrl(url)}
      externalUrl={getOpenableExternalUrl(failedNavigationUrl)}
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
