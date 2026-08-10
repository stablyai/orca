export const GIT_WORKTREE_HOST_LOCK_PROBE_CONCURRENCY = 4

export async function runGitWorktreeHostClaimScan(
  entryCount: number,
  scanNext: () => Promise<void>
): Promise<void> {
  const workerCount = Math.min(GIT_WORKTREE_HOST_LOCK_PROBE_CONCURRENCY, entryCount)
  await Promise.all(Array.from({ length: workerCount }, () => scanNext()))
}
