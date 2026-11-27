import React from 'react'
import WorktreeContextMenuView from './WorktreeContextMenuView'
import type { AutoNameFailure } from '../../workspace-card/identity/use-auto-name-failure'
import {
  useWorktreeContextMenuModel,
  type WorktreeContextMenuProps
} from './use-worktree-context-menu-model'

const WorktreeContextMenu = React.memo(function WorktreeContextMenu({
  autoNameFailure = null,
  ...props
}: WorktreeContextMenuProps & {
  /** The row's failed auto-name, whose hover-card actions the menu repeats for keyboard use. */
  autoNameFailure?: AutoNameFailure | null
}) {
  const model = useWorktreeContextMenuModel(props)
  return <WorktreeContextMenuView model={model} autoNameFailure={autoNameFailure} />
})

export default WorktreeContextMenu
import './worktree-context-menu-policy'
