import { BrowserNewTabPage } from '../../new-tab/BrowserNewTabPage'
import { ClientHostedBrowserUnavailableNotice } from './client-hosted-browser-unavailable-notice'
import { useServerBrowserPageProfileId } from '../profile-routing/use-server-browser-page-profile-id'

/** What a server's page shows in place of its guest: the unavailable notice or its new tab page. */
export function ClientHostedBrowserPageStandIn({
  unavailable,
  showNewTab,
  runtimeEnvironmentId,
  worktreeId,
  browserPageId,
  reopenUrl,
  placementHostClientId,
  onOpenUrl
}: {
  unavailable: boolean
  showNewTab: boolean
  runtimeEnvironmentId: string
  worktreeId: string
  browserPageId: string
  reopenUrl: string
  placementHostClientId: string | null
  onOpenUrl: (url: string) => void
}): React.JSX.Element | null {
  const browserProfileId = useServerBrowserPageProfileId(browserPageId)
  if (unavailable) {
    return (
      <ClientHostedBrowserUnavailableNotice
        runtimeEnvironmentId={runtimeEnvironmentId}
        worktreeId={worktreeId}
        reopenUrl={reopenUrl}
        placementHostClientId={placementHostClientId}
      />
    )
  }
  if (!showNewTab) {
    return null
  }
  return (
    <BrowserNewTabPage
      page={{ id: browserPageId, worktreeId }}
      onOpenUrl={onOpenUrl}
      serversElsewhere
      importProfileId={browserProfileId}
      importClientHostedPage={{ environmentId: runtimeEnvironmentId, browserPageId }}
    />
  )
}
