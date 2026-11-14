import type {
  GlobalSettings,
  WorktreeVisibilityDefaults
} from '../../../../../../shared/global-settings-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { getRepoOwnerWorktreeVisibilityDefaults } from '../../../../store/slices/worktrees/listing/worktree-visibility-defaults-by-host'
import type { Repo } from '../../../../../../shared/repo-types'
import type { DetectedWorktreeListResult, Worktree } from '../../../../../../shared/worktree/types'
import { getHiddenExternalWorktrees as getHiddenImportedWorktrees } from '../../../../../../shared/external-worktree-inbox'
import { isGitRepoKind } from '../../../../../../shared/repo-kind'
import { isRepoHidden } from '../../../../../../shared/hidden-projects'
import '../../../../../../shared/worktree/visibility/ownership'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../../../shared/external-worktree-visibility'
import type { ImportedWorktreesCardCandidate } from '../../../../../../shared/sidebar-list/row-types'

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
    // A hidden project draws nothing in the sidebar, notices included.
    if (!isGitRepoKind(repo) || isRepoHidden(repo)) {
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
