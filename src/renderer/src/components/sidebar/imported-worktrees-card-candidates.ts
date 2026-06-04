import type {
  DetectedWorktree,
  DetectedWorktreeListResult,
  Repo,
  Worktree
} from '../../../../shared/types'
import { isGitRepoKind } from '../../../../shared/repo-kind'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from '../../../../shared/worktree-ownership'
import type { ImportedWorktreesCardCandidate } from './worktree-list-groups'

export function getHiddenImportedWorktrees(
  detected: DetectedWorktreeListResult | undefined
): DetectedWorktree[] {
  if (detected?.authoritative !== true) {
    return []
  }
  return detected.worktrees.filter(
    (worktree) =>
      !worktree.visible && !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
  )
}

export function buildImportedWorktreesCardCandidates(args: {
  repos: readonly Repo[]
  visibleWorktrees?: readonly Worktree[]
  detectedWorktreesByRepo: Readonly<Record<string, DetectedWorktreeListResult | undefined>>
  filterRepoIds?: readonly string[]
  forceVisibleRepoIds?: ReadonlySet<string>
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
      isLegacyRepoForExternalWorktreeVisibility(repo)
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
