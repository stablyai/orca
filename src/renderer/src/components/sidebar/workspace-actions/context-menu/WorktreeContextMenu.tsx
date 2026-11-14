import React from 'react'
import WorktreeContextMenuView from './WorktreeContextMenuView'
import {
  useWorktreeContextMenuModel,
  type WorktreeContextMenuProps
} from './use-worktree-context-menu-model'

const WorktreeContextMenu = React.memo(function WorktreeContextMenu(
  props: WorktreeContextMenuProps
) {
  const model = useWorktreeContextMenuModel(props)
  return <WorktreeContextMenuView model={model} />
})

export default WorktreeContextMenu
import './worktree-context-menu-policy'
