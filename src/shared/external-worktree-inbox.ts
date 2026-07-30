import { normalizeRuntimePathForComparison } from './cross-platform-path'
import type { DetectedWorktree, DetectedWorktreeListResult, Repo } from './types'
import {
  effectiveExternalWorktreeVisibility,
  isLegacyRepoForExternalWorktreeVisibility
} from './external-worktree-visibility'

export function normalizeExternalWorktreeInboxPath(path: string): string {
  return normalizeRuntimePathForComparison(path)
}

export function areExternalWorktreeInboxPathsEqual(leftPath: string, rightPath: string): boolean {
  return (
    normalizeExternalWorktreeInboxPath(leftPath) === normalizeExternalWorktreeInboxPath(rightPath)
  )
}

export function mergeExternalWorktreeInboxPaths(
  existing: readonly string[] | undefined,
  additions: readonly string[]
): string[] {
  const seen = new Set((existing ?? []).map((path) => normalizeExternalWorktreeInboxPath(path)))
  const merged = [...(existing ?? [])]
  for (const path of additions) {
    const normalized = normalizeExternalWorktreeInboxPath(path)
    if (!normalized || seen.has(normalized)) {
      continue
    }
    seen.add(normalized)
    merged.push(path)
  }
  return merged
}

export function getHiddenExternalWorktrees(
  detected: DetectedWorktreeListResult | undefined
): DetectedWorktree[] {
  if (detected?.authoritative !== true) {
    return []
  }
  return detected.worktrees.filter(
    (worktree) => !worktree.visible && isUserFacingExternalWorktree(worktree)
  )
}

export function getHiddenImportableExternalWorktrees(
  detected: DetectedWorktreeListResult | undefined
): DetectedWorktree[] {
  if (detected?.authoritative !== true) {
    return []
  }
  return detected.worktrees.filter(
    (worktree) => !worktree.visible && isImportableExternalWorktree(worktree)
  )
}

export function getVisibleExternalWorktrees(
  detected: DetectedWorktreeListResult | undefined
): DetectedWorktree[] {
  if (detected?.authoritative !== true) {
    return []
  }
  return detected.worktrees.filter(
    (worktree) => worktree.visible && isUserFacingExternalWorktree(worktree)
  )
}

function isUserFacingExternalWorktree(worktree: DetectedWorktree): boolean {
  // Why: an explicit scratch import may be visible, but agent plumbing must
  // stay outside repo-wide discovery and visibility controls (#9388).
  return (
    !worktree.selectedCheckout &&
    worktree.ownership !== 'orca-managed' &&
    worktree.ownership !== 'agent-scratch'
  )
}

function isImportableExternalWorktree(worktree: DetectedWorktree): boolean {
  // Why: scratch is not user-facing, but the visibility toggle can never reveal
  // it, so explicit import is its only reachable path back (#10324).
  return !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
}

export function isExternalWorktreeDiscoverySuppressed(
  repo: Pick<Repo, 'externalWorktreeDiscoverySuppressedAt'>
): boolean {
  return typeof repo.externalWorktreeDiscoverySuppressedAt === 'number'
}

export function hasCompletedInitialExternalWorktreeImportPrompt(
  repo: Pick<Repo, 'externalWorktreeVisibilityPromptDismissedAt'>
): boolean {
  return typeof repo.externalWorktreeVisibilityPromptDismissedAt === 'number'
}

export function shouldOfferNewExternalWorktreeInbox(repo: Repo): boolean {
  if (isExternalWorktreeDiscoverySuppressed(repo)) {
    return false
  }
  if (!hasCompletedInitialExternalWorktreeImportPrompt(repo)) {
    return false
  }
  return (
    effectiveExternalWorktreeVisibility(repo, isLegacyRepoForExternalWorktreeVisibility(repo)) ===
    'hide'
  )
}

export function getNewExternalWorktreeInboxWorktrees(
  detected: DetectedWorktreeListResult | undefined,
  repo: Repo
): DetectedWorktree[] {
  if (isExternalWorktreeDiscoverySuppressed(repo)) {
    return []
  }
  // Why: the visibility toggle and its first-run prompt only govern non-Orca
  // worktrees, so gating scratch on either leaves it unreachable (#10324).
  const offersNonScratch = shouldOfferNewExternalWorktreeInbox(repo)
  const baseline = new Set(
    (repo.externalWorktreeInboxBaselinePaths ?? []).map((path) =>
      normalizeExternalWorktreeInboxPath(path)
    )
  )
  return getHiddenImportableExternalWorktrees(detected).filter(
    (worktree) =>
      (offersNonScratch || worktree.ownership === 'agent-scratch') &&
      !baseline.has(normalizeExternalWorktreeInboxPath(worktree.path))
  )
}

export function isExplicitlyImportedExternalWorktreePath(
  worktreePath: string,
  repo: { importedExternalWorktreePaths?: readonly string[] }
): boolean {
  return (repo.importedExternalWorktreePaths ?? []).some((path) =>
    areExternalWorktreeInboxPathsEqual(path, worktreePath)
  )
}
