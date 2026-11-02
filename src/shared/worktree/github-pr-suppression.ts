import type { Worktree } from './types'
import type { WorktreeMeta } from './meta-types'

type GitHubPRSuppressionMetadata = Pick<Worktree, 'linkedPR' | 'suppressedGitHubPR'>

export function isGitHubPRSuppressed(
  { linkedPR, suppressedGitHubPR }: GitHubPRSuppressionMetadata,
  prNumber: number
): boolean {
  return linkedPR === null && suppressedGitHubPR === prNumber
}

export function normalizeGitHubPRSuppressionUpdate(
  updates: Partial<WorktreeMeta>
): Partial<WorktreeMeta> {
  return typeof updates.linkedPR === 'number' && updates.linkedPR > 0
    ? { ...updates, suppressedGitHubPR: null }
    : updates
}
