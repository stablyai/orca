import type { NestedRepoCandidate } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { normalizeRuntimePathForComparison } from '../../../../../../shared/cross-platform-path'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { isGitRepoKind } from '../../../../../../shared/repo-kind'

export type FolderSourceControlRepository = {
  candidate: NestedRepoCandidate
  repo: Repo | null
  worktree: Worktree | null
}

function pickPrimaryWorktree(repo: Repo, worktrees: readonly Worktree[]): Worktree | null {
  const repoPath = normalizeRuntimePathForComparison(repo.path)
  const repoHostId = getRepoExecutionHostId(repo)
  const eligible = worktrees.filter(
    (worktree) => !worktree.isArchived && (!worktree.hostId || worktree.hostId === repoHostId)
  )
  return (
    eligible.find((worktree) => normalizeRuntimePathForComparison(worktree.path) === repoPath) ??
    eligible.find((worktree) => worktree.isMainWorktree) ??
    null
  )
}

export function resolveFolderSourceControlRepositories(args: {
  candidates: readonly NestedRepoCandidate[]
  repos: readonly Repo[]
  worktreesByRepo: Record<string, readonly Worktree[]>
  executionHostId: string
}): FolderSourceControlRepository[] {
  const reposByPath = new Map<string, Repo>()
  for (const repo of args.repos) {
    if (!isGitRepoKind(repo) || getRepoExecutionHostId(repo) !== args.executionHostId) {
      continue
    }
    reposByPath.set(normalizeRuntimePathForComparison(repo.path), repo)
  }

  return args.candidates.map((candidate) => {
    const repo = reposByPath.get(normalizeRuntimePathForComparison(candidate.path)) ?? null
    return {
      candidate,
      repo,
      worktree: repo ? pickPrimaryWorktree(repo, args.worktreesByRepo[repo.id] ?? []) : null
    }
  })
}
