import React from 'react'
import WorktreeContextMenuView from './WorktreeContextMenuView'
import { useWorktreeContextMenuModel } from './use-worktree-context-menu-model'
import type { Worktree } from '../../../../../../shared/worktree/types'

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

const WorktreeContextMenu = React.memo(function WorktreeContextMenu(
  props: WorktreeContextMenuProps
) {
  const model = useWorktreeContextMenuModel(props)
  return <WorktreeContextMenuView model={model} />
})

export default WorktreeContextMenu
import './worktree-context-menu-policy'
