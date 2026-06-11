import { isPathInsideOrEqual } from '../../../../shared/cross-platform-path'
import type { Repo } from '../../../../shared/types'

export function findSessionRepo(
  cwd: string | null,
  repos: readonly Repo[],
  worktreesByRepo: Record<string, readonly { path: string }[] | undefined>
): Repo | null {
  if (!cwd) {
    return null
  }
  let bestRepo: Repo | null = null
  let bestPathLength = -1

  const consider = (repo: Repo, path: string): void => {
    if (!path || !isPathInsideOrEqual(path, cwd)) {
      return
    }
    if (path.length > bestPathLength) {
      bestRepo = repo
      bestPathLength = path.length
    }
  }

  for (const repo of repos) {
    consider(repo, repo.path)
    for (const worktree of worktreesByRepo[repo.id] ?? []) {
      consider(repo, worktree.path)
    }
  }

  return bestRepo
}
