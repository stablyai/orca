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
import { getHiddenExternalWorktrees } from '../../../../shared/external-worktree-inbox'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree/ownership'
import type { ImportedWorktreesCardCandidate } from '../../../../shared/sidebar-list/row-types'

export function getHiddenImportedWorktrees(
  detected: DetectedWorktreeListResult | undefined
): ReturnType<typeof getHiddenExternalWorktrees> {
  return getHiddenExternalWorktrees(detected)
}

export function buildImportedWorktreesCardCandidates(args: {
  repos: readonly Repo[]
  allRepos?: readonly Repo[]
  detectedWorktreesByHost?: ReadonlyMap<string, DetectedWorktreeListResult>
  visibleWorktrees?: readonly Worktree[]
  detectedWorktreesByRepo: Readonly<Record<string, DetectedWorktreeListResult | undefined>>
  filterRepoIds?: readonly string[]
  forceVisibleRepoIds?: ReadonlySet<string>
  settings?: Pick<GlobalSettings, 'worktreeVisibilityDefaults'> | null
  visibilityDefaultsByHost?: Partial<Record<ExecutionHostId, WorktreeVisibilityDefaults | null>>
}): Map<string, ImportedWorktreesCardCandidate> {
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
  const candidates = new Map<string, ImportedWorktreesCardCandidate>()
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
    if (typeof repo.externalWorktreeVisibilityPromptDismissedAt === 'number') {
      continue
    }
    const visibility = effectiveExternalWorktreeVisibility(
      repo,
      isLegacyRepoForExternalWorktreeVisibility(repo),
      getRepoOwnerWorktreeVisibilityDefaults(
        repo,
        args.settings,
        args.visibilityDefaultsByHost ?? {}
      )
    )
    if (visibility !== 'hide' && !args.forceVisibleRepoIds?.has(getRepoHostIdentity(repo))) {
      continue
    }
    const hiddenWorktrees = getHiddenImportedWorktrees(
      detectedByHost.get(getRepoHostIdentity(repo))
    )
    if (hiddenWorktrees.length > 0) {
      candidates.set(getRepoHostIdentity(repo), { repo, hiddenWorktrees })
    }
  }
  return candidates
}
