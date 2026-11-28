import { basename } from '@/lib/path'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'

export type FileExplorerTitle = { repoName: string; worktreeName: string | null }

/** The explorer header: the project, and for a git project which of its worktrees is shown. */
export function getFileExplorerTitle(
  repo: Pick<Repo, 'displayName' | 'kind'> | null | undefined,
  worktree: Pick<Worktree, 'displayName' | 'branch' | 'path'> | null | undefined
): FileExplorerTitle {
  const repoName = repo?.displayName ?? (worktree?.path ? basename(worktree.path) : '')
  // A folder project has a single root, so its name already says where the tree is.
  if (!repo || !worktree || !isGitRepoKind(repo)) {
    return { repoName, worktreeName: null }
  }
  const worktreeName = resolveWorktreeDisplayName(worktree)
  return { repoName, worktreeName: worktreeName && worktreeName !== repoName ? worktreeName : null }
}
