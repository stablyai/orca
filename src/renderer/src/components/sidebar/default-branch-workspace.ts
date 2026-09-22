import type { Worktree } from '../../../../shared/worktree/types'

/** Keeps provisioned roots visible because they are the recipe-created workspace, not a source-repo row. */
export function isDefaultBranchWorkspace(worktree: Worktree): boolean {
  return (
    worktree.isMainWorktree &&
    worktree.branch.trim() !== '' &&
    worktree.ephemeralVmCheckoutMode !== 'provisioned-root'
  )
}
