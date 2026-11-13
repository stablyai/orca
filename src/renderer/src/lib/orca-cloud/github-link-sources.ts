// "Copy link" for the GitHub handoffs: the same single-use page Connect GitHub (App install) and
// Connect your GitHub (OAuth) open, minted the same way in main but returned instead of opened.
import { requireLink, type ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { cloudWorkspaceApi } from './orca-cloud-workspace-store'

/** The GitHub App install page; with a repository, GitHub preselects it (and a setup session returns). */
export function gitHubInstallLinkSource(args?: {
  repoUrl?: string
  setupSessionId?: string
}): ExternalLinkSource {
  return async () => {
    const result = await cloudWorkspaceApi()?.gitHubInstallLink(args)
    return requireLink(result?.ok ? result.value : null)
  }
}

/** GitHub's OAuth page for connecting the person's own GitHub identity. */
export function gitHubUserConnectLinkSource(): ExternalLinkSource {
  return async () => {
    const result = await cloudWorkspaceApi()?.gitHubUserConnectLink()
    return requireLink(result?.ok ? result.value : null)
  }
}
