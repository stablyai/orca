import type { Worktree } from '../../../../shared/worktree/types'
export type WorktreeContextMenuProps = {
  worktree: Worktree
  children: React.ReactNode
  contentClassName?: string
  selectedWorktrees?: readonly Worktree[]
  onContextMenuSelect?: (event: React.MouseEvent<HTMLElement>) => readonly Worktree[]
  onAssignWorkspaceStatus?: (worktreeIds: readonly string[], status: string) => void
  onOpenChange?: (open: boolean) => void
  onLifecycleComplete?: () => void
}
