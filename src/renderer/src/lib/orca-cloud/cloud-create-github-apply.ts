// CREATE-GH-STEP: a GitHub access grant that lands while the create's sandbox is already up. The
// sandbox booted without the Orca GitHub App's repository token, so its git has neither the token
// route nor the auth header; this hands it both before the workspace opens, so no restart is needed.
// Best effort: when it can't, the workspace still opens and the push notice (Check again) remains.
export type CloudGitHubAccessTarget = { sandboxId: string } | { environmentId: string }

export async function applyCloudGitHubAccessToSandbox(
  _target: CloudGitHubAccessTarget
): Promise<boolean> {
  // GH-LIVE-REFRESH (gh-access) supplies the live refresh; until it lands nothing is applied here.
  return false
}
