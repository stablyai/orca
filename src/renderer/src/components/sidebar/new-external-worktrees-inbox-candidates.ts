import type {
  GlobalSettings,
  WorktreeVisibilityDefaults
} from '../../../../shared/global-settings-types'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../store/worktree-visibility-defaults-by-host'
import type { Repo } from '../../../../shared/repo-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../shared/worktree/types'
import { getNewExternalWorktreeInboxWorktrees } from '../../../../shared/external-worktree-inbox'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import type { NewExternalWorktreesInboxCandidate } from './worktree-list/grouping/row-types'

export function buildNewExternalWorktreesInboxCandidates(args: {
  repos: readonly Repo[]
  visibleWorktrees?: readonly Worktree[]
  detectedWorktreesByRepo: Readonly<Record<string, DetectedWorktreeListResult | undefined>>
  filterRepoIds?: readonly string[]
  settings?: Pick<GlobalSettings, 'worktreeVisibilityDefaults'> | null
  visibilityDefaultsByHost?: Partial<Record<ExecutionHostId, WorktreeVisibilityDefaults | null>>
}): Map<string, NewExternalWorktreesInboxCandidate> {
  const visibleRepoIds = args.visibleWorktrees
    ? new Set(args.visibleWorktrees.map((worktree) => worktree.repoId))
    : null
  const filterRepoIds = args.filterRepoIds?.length ? new Set(args.filterRepoIds) : null
  const candidates = new Map<string, NewExternalWorktreesInboxCandidate>()
  for (const repo of args.repos) {
    if (filterRepoIds && !filterRepoIds.has(repo.id)) {
      continue
    }
    if (visibleRepoIds && !visibleRepoIds.has(repo.id)) {
      continue
    }
    if (!isGitRepoKind(repo)) {
      continue
    }
    const inboxWorktrees = getNewExternalWorktreeInboxWorktrees(
      args.detectedWorktreesByRepo[repo.id],
      repo,
      getRepoOwnerWorktreeVisibilityDefaults(
        repo,
        args.settings,
        args.visibilityDefaultsByHost ?? {}
      )
    )
    if (inboxWorktrees.length > 0) {
      candidates.set(repo.id, { repo, inboxWorktrees })
    }
  }
  return candidates
}
