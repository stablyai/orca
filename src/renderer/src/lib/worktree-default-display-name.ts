import { branchName } from '@/lib/git-utils'
import { basename } from '@/lib/path'
import type { Worktree } from '../../../shared/worktree/types'

type WorktreeDisplayNameSource = Pick<Worktree, 'displayName' | 'branch' | 'path'>

/** Folder/partially hydrated rows can lack the required branch field; route render/search reads here because branchName throws on undefined. */
export function resolveWorktreeBranchLabel(worktree: Pick<Worktree, 'branch'>): string {
  return typeof worktree.branch === 'string' ? branchName(worktree.branch) : ''
}

/** Mirror main’s mergeWorktree fallback: nonblank custom name → branch → folder. Clearing a custom name can leave required displayName undefined (crash a1f81ea1). */
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
