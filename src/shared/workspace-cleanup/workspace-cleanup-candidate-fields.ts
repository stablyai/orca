import type { DiffComment } from '../diff-comment-types'

export type WorkspaceCleanupDiffCommentTimes = readonly Pick<DiffComment, 'createdAt'>[]

export function shortWorkspaceCleanupBranchName(branch: string): string {
  return branch.replace(/^refs\/heads\//, '') || 'HEAD'
}

export function getNewestWorkspaceCleanupDiffCommentAt(
  diffComments: WorkspaceCleanupDiffCommentTimes | undefined
): number | null {
  if (!diffComments || diffComments.length === 0) {
    return null
  }
  // Large persisted note arrays can exceed JavaScript's spread argument limit.
  let newest = diffComments[0]?.createdAt ?? null
  for (let index = 1; index < diffComments.length; index += 1) {
    const createdAt = diffComments[index]?.createdAt
    if (createdAt !== undefined && (newest === null || createdAt > newest)) {
      newest = createdAt
    }
  }
  return newest
}
