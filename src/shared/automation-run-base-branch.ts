const AUTOMATION_RUN_BASE_REMOTE = 'origin'

// Why: a bare base like `main` is the local branch, so unpushed commits leaked into unattended runs.
// Prefer `origin/<name>` when it exists; explicit, full and local-only refs are kept as stored.
export async function resolveAutomationRunBaseBranch(
  baseBranch: string | null | undefined,
  hasRemoteTrackingRef: (remoteBase: string) => Promise<boolean>
): Promise<string | undefined> {
  if (!baseBranch) {
    return undefined
  }
  if (baseBranch.startsWith('refs/') || baseBranch.startsWith(`${AUTOMATION_RUN_BASE_REMOTE}/`)) {
    return baseBranch
  }
  const remoteBase = `${AUTOMATION_RUN_BASE_REMOTE}/${baseBranch}`
  try {
    return (await hasRemoteTrackingRef(remoteBase)) ? remoteBase : baseBranch
  } catch {
    // A failed probe must not block the run.
    return baseBranch
  }
}
