// CREATE-GH-STEP: a GitHub access grant that lands while the create's sandbox is already up. The
// sandbox booted without the Orca GitHub App's repository token, so its git has neither the token
// route nor the auth header; the control plane's live refresh (LIVE-GIT-ACCESS) hands it both before
// the workspace opens, so no restart is needed. Best effort: when it can't, the workspace still
// opens and the push notice (Check again, then Restart) remains.
import type { OrcaCloudWorkspaceApi } from '../../../../shared/hosted-sandbox/cloud-workspace-api'
import { cloudWorkspaceApi } from './orca-cloud-workspace-store'

export type CloudGitHubAccessTarget = Parameters<
  NonNullable<OrcaCloudWorkspaceApi['refreshGitAccess']>
>[0]

/** True once the sandbox's git uses the App's token. */
export async function applyCloudGitHubAccessToSandbox(
  target: CloudGitHubAccessTarget
): Promise<boolean> {
  const result = await cloudWorkspaceApi()
    ?.refreshGitAccess?.(target)
    .catch(() => null)
  return Boolean(result?.ok && result.value.applied)
}
