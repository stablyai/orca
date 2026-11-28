import { normalizeRuntimePathForComparison } from '../../file-access/cross-platform-path'
import type { WorktreeVisibilityDefaults, Repo } from '../../repository/repo-types'
import type { DetectedWorktree, DetectedWorktreeListResult } from '../types'
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
  // Agent plumbing stays outside discovery even when its separate visibility policy shows it.
  return (
    !worktree.selectedCheckout &&
    worktree.ownership !== 'orca-managed' &&
    worktree.ownership !== 'agent-scratch'
  )
}

// Keep per-path recovery available when either visibility policy is off.
function isImportableExternalWorktree(worktree: DetectedWorktree): boolean {
  return !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
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

export function getVisibleNonOrcaWorktrees(
  detected: DetectedWorktreeListResult | undefined
): DetectedWorktree[] {
  if (detected?.authoritative !== true) {
    return []
  }
  return detected.worktrees.filter(
    (worktree) =>
      worktree.visible && !worktree.selectedCheckout && worktree.ownership !== 'orca-managed'
  )
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

export function shouldOfferNewExternalWorktreeInbox(
  repo: Repo,
  defaults?: WorktreeVisibilityDefaults
): boolean {
  if (isExternalWorktreeDiscoverySuppressed(repo)) {
    return false
  }
  if (!hasCompletedInitialExternalWorktreeImportPrompt(repo)) {
    return false
  }
  return (
    effectiveExternalWorktreeVisibility(
      repo,
      isLegacyRepoForExternalWorktreeVisibility(repo),
      defaults
    ) === 'hide'
  )
}

export function getNewExternalWorktreeInboxWorktrees(
  detected: DetectedWorktreeListResult | undefined,
  repo: Repo,
  defaults?: WorktreeVisibilityDefaults
): DetectedWorktree[] {
  if (!shouldOfferNewExternalWorktreeInbox(repo, defaults)) {
    return []
  }
  const baseline = new Set(
    (repo.externalWorktreeInboxBaselinePaths ?? []).map((path) =>
      normalizeExternalWorktreeInboxPath(path)
    )
  )
  return getHiddenExternalWorktrees(detected).filter(
    (worktree) => !baseline.has(normalizeExternalWorktreeInboxPath(worktree.path))
  )
}

// Why: listings check every worktree against the same repo array; rescanning it was O(n²) at fleet scale.
const normalizedImportedPathSets = new WeakMap<readonly string[], ReadonlySet<string>>()

function getNormalizedImportedPathSet(paths: readonly string[]): ReadonlySet<string> {
  let normalized = normalizedImportedPathSets.get(paths)
  if (!normalized) {
    normalized = new Set(paths.map((path) => normalizeExternalWorktreeInboxPath(path)))
    normalizedImportedPathSets.set(paths, normalized)
  }
  return normalized
}

export function isExplicitlyImportedExternalWorktreePath(
  worktreePath: string,
  repo: { importedExternalWorktreePaths?: readonly string[] }
): boolean {
  const paths = repo.importedExternalWorktreePaths
  if (!paths || paths.length === 0) {
    return false
  }
  return getNormalizedImportedPathSet(paths).has(normalizeExternalWorktreeInboxPath(worktreePath))
}
