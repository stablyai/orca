import { getProjectRepoFilterHost } from '../../../../shared/project-repo-filter-selection'
import {
  getRepoHostIdentity,
  getRepoHostIdentityForParts
} from '../../../../shared/repo-host-identity'
import { getRepoHostSummaries } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import {
  getDetectedWorktreeOwnerHost,
  partitionDetectedWorktreesByHost
} from './worktree-visibility-host-target'
import { projectRepoFilterMatcher } from '../../../../shared/project-grouping'
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
import type { NewExternalWorktreesInboxCandidate } from '../../../../shared/sidebar-list/row-types'

export function buildNewExternalWorktreesInboxCandidates(args: {
  repos: readonly Repo[]
  allRepos?: readonly Repo[]
  detectedWorktreesByHost?: ReadonlyMap<string, DetectedWorktreeListResult>
  visibleWorktrees?: readonly Worktree[]
  detectedWorktreesByRepo: Readonly<Record<string, DetectedWorktreeListResult | undefined>>
  filterRepoIds?: readonly string[]
  settings?: Pick<GlobalSettings, 'worktreeVisibilityDefaults'> | null
  visibilityDefaultsByHost?: Partial<Record<ExecutionHostId, WorktreeVisibilityDefaults | null>>
}): Map<string, NewExternalWorktreesInboxCandidate> {
  const allRepos = args.allRepos ?? args.repos
  const summaries = getRepoHostSummaries(allRepos)
  const detectedByHost =
    args.detectedWorktreesByHost ??
    partitionDetectedWorktreesByHost(allRepos, args.detectedWorktreesByRepo)
  const visibleRepoIds = args.visibleWorktrees
    ? new Set(
        args.visibleWorktrees.map((worktree) =>
          getRepoHostIdentityForParts(
            worktree.repoId,
            getDetectedWorktreeOwnerHost(worktree, summaries.get(worktree.repoId))
          )
        )
      )
    : null
  const matchesRepo = projectRepoFilterMatcher(args.filterRepoIds ?? [])
  const candidates = new Map<string, NewExternalWorktreesInboxCandidate>()
  for (const repo of args.repos) {
    if (!matchesRepo(repo.id, getProjectRepoFilterHost(repo))) {
      continue
    }
    if (visibleRepoIds && !visibleRepoIds.has(getRepoHostIdentity(repo))) {
      continue
    }
    if (!isGitRepoKind(repo)) {
      continue
    }
    const inboxWorktrees = getNewExternalWorktreeInboxWorktrees(
      detectedByHost.get(getRepoHostIdentity(repo)),
      repo,
      getRepoOwnerWorktreeVisibilityDefaults(
        repo,
        args.settings,
        args.visibilityDefaultsByHost ?? {}
      )
    )
    if (inboxWorktrees.length > 0) {
      candidates.set(getRepoHostIdentity(repo), { repo, inboxWorktrees })
    }
  }
  return candidates
}
