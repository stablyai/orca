import { useLayoutEffect } from 'react'
import { registerVisibleTerminalWorktree } from '@/lib/foreground-terminal-worktrees'

type VisibleTerminalWorktreeClaimOptions = {
  isVisible: boolean
  worktreeId: string
}

export function useVisibleTerminalWorktreeClaim({
  isVisible,
  worktreeId
}: VisibleTerminalWorktreeClaimOptions): void {
  useLayoutEffect(() => {
    if (!isVisible) {
      return
    }
    // Why: agent sleep must fail closed before paint for any pane the user can
    // see, even when global active-worktree state is between views.
    return registerVisibleTerminalWorktree(worktreeId)
  }, [isVisible, worktreeId])
}
