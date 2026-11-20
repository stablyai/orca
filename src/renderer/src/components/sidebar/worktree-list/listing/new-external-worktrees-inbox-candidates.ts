import type { GlobalSettings } from '../../../../../../shared/settings/global-settings-types'
import type {
  WorktreeVisibilityDefaults,
  Repo
} from '../../../../../../shared/repository/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../../store/slices/worktrees/listing/worktree-visibility-defaults-by-host'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import { getNewExternalWorktreeInboxWorktrees } from '../../../../../../shared/worktree/visibility/external-worktree-inbox'
import { isGitRepoKind } from '../../../../../../shared/repository/repo-kind'
import { isRepoHidden } from '../../../../../../shared/project/catalog/hidden-projects'
import type { NewExternalWorktreesInboxCandidate } from '../../../../../../shared/sidebar-list/row-types'

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
    // A hidden project draws nothing in the sidebar, notices included.
    if (!isGitRepoKind(repo) || isRepoHidden(repo)) {
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
