/**
 * Remote name for best-effort full `git fetch <remote>` when creating worktrees
 * or refreshing the base-ref catalog. Prefer the repo's recorded canonical
 * remote (often `upstream` on fork clones); fall back to `origin`.
 */
export function resolveWorktreeBroadFetchRemoteName(repo: {
  gitRemoteIdentity?: { remoteName?: string } | null
}): string {
  const remoteName = repo.gitRemoteIdentity?.remoteName?.trim()
  return remoteName && remoteName.length > 0 ? remoteName : 'origin'
}
