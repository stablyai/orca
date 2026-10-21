import type { GitWorktreeInfo } from './types'

export const NESTED_WORKTREE_REMOVAL_PREFIX =
  'Refusing to delete worktree because it contains another registered worktree:'

export type NestedWorktreeRemovalApproval = Pick<GitWorktreeInfo, 'path' | 'head' | 'branch'>

export function isNestedWorktreeRemovalError(error: string): boolean {
  return error.includes(NESTED_WORKTREE_REMOVAL_PREFIX)
}
