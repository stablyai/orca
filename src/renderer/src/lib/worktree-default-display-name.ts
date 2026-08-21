import { branchName } from '@/lib/git-utils'
import { basename } from '@/lib/path'
import type { Worktree } from '../../../shared/worktree/types'

type WorktreeDisplayNameSource = Pick<Worktree, 'displayName' | 'branch' | 'path'>

/**
 * `branch` is typed non-optional but is absent on folder workspaces and
 * partially hydrated rows, and `branchName` throws on undefined. Every render
 * and search read of the branch label must go through here.
 */
export function resolveWorktreeBranchLabel(worktree: Pick<Worktree, 'branch'>): string {
  return typeof worktree.branch === 'string' ? branchName(worktree.branch) : ''
}

/**
 * Renderer mirror of main-side `mergeWorktree`: a missing or blank custom name
 * falls back to the branch, then the folder. `displayName` is typed non-optional
 * but arrives undefined at runtime once a custom name is cleared (crash
 * a1f81ea1), so every read must go through here instead of dereferencing it.
 */
export function resolveWorktreeDisplayName(worktree: WorktreeDisplayNameSource): string {
  const custom = typeof worktree.displayName === 'string' ? worktree.displayName.trim() : ''
  if (custom) {
    return custom
  }

  const branch = resolveWorktreeBranchLabel(worktree).trim()
  if (branch) {
    return branch
  }

  return typeof worktree.path === 'string' ? basename(worktree.path).trim() : ''
}
