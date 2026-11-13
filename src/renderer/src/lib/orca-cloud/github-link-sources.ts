// "Copy link" for connecting your GitHub identity (OAuth sign-in): the same single-use page Connect
// your GitHub opens, minted the same way in main but returned instead of opened. Copy link is for
// sign-in pages only; the GitHub App install keeps a plain button.
import { requireLink, type ExternalLinkSource } from '@/components/open-external/copy-external-link'
import { cloudWorkspaceApi } from './orca-cloud-workspace-store'

/** GitHub's OAuth page for connecting the person's own GitHub identity. */
export function gitHubUserConnectLinkSource(): ExternalLinkSource {
  return async () => {
    const result = await cloudWorkspaceApi()?.gitHubUserConnectLink()
    return requireLink(result?.ok ? result.value : null)
  }
}
