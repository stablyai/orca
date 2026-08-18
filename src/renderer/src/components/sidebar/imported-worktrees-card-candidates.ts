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
import type { ImportedWorktreesCardCandidate } from './worktree-list/grouping/row-types'

export function getHiddenImportedWorktrees(
  detected: DetectedWorktreeListResult | undefined
): ReturnType<typeof getHiddenExternalWorktrees> {
  return getHiddenExternalWorktrees(detected)
}

export function buildImportedWorktreesCardCandidates(args: {
  repos: readonly Repo[]
  visibleWorktrees?: readonly Worktree[]
  detectedWorktreesByRepo: Readonly<Record<string, DetectedWorktreeListResult | undefined>>
  filterRepoIds?: readonly string[]
  forceVisibleRepoIds?: ReadonlySet<string>
  settings?: Pick<GlobalSettings, 'worktreeVisibilityDefaults'> | null
  visibilityDefaultsByHost?: Partial<Record<ExecutionHostId, WorktreeVisibilityDefaults | null>>
}): Map<string, ImportedWorktreesCardCandidate> {
  const visibleRepoIds = args.visibleWorktrees
    ? new Set(args.visibleWorktrees.map((worktree) => worktree.repoId))
    : null
  const filterRepoIds = args.filterRepoIds?.length ? new Set(args.filterRepoIds) : null
  const candidates = new Map<string, ImportedWorktreesCardCandidate>()
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
    if (visibility !== 'hide' && !args.forceVisibleRepoIds?.has(repo.id)) {
      continue
    }
    const hiddenWorktrees = getHiddenImportedWorktrees(args.detectedWorktreesByRepo[repo.id])
    if (hiddenWorktrees.length > 0) {
      candidates.set(repo.id, { repo, hiddenWorktrees })
    }
  }
  return candidates
}
