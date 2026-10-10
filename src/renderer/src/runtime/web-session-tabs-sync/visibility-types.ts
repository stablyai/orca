import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

/** The floating terminal is local-only and never belongs to a host mirror. */
export function isHostMirroredWorktree(worktreeId: string): boolean {
  return worktreeId !== FLOATING_TERMINAL_WORKTREE_ID
}
