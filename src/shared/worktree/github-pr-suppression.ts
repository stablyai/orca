import type { Worktree } from './types'
import type { WorktreeMeta } from './meta-types'

type GitHubPRSuppressionMetadata = Pick<Worktree, 'linkedPR' | 'suppressedGitHubPR'>

export function isGitHubPRSuppressed(
  { linkedPR, suppressedGitHubPR }: GitHubPRSuppressionMetadata,
  prNumber: number
): boolean {
  return linkedPR === null && suppressedGitHubPR === prNumber
}

/** Selecting a PR lifts a suppression; restating the already-selected PR leaves it alone. */
export function normalizeGitHubPRSuppressionUpdate(
  updates: Partial<WorktreeMeta>,
  currentLinkedPR?: number | null
): Partial<WorktreeMeta> {
  return typeof updates.linkedPR === 'number' &&
    updates.linkedPR > 0 &&
    updates.linkedPR !== currentLinkedPR
    ? { ...updates, suppressedGitHubPR: null }
    : updates
}
