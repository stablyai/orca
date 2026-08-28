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
export {
  CLOSE_ALL_CONTEXT_MENUS_EVENT,
  WORKTREE_CONTEXT_MENU_SCOPE_ATTR,
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR,
  getWorktreeParentPickerAnchor,
  getWorktreeParentPickerLabel,
  hasWorktreeParentLink,
  isContextWorktreeDeletable,
  isWorktreeParentPickerDisabled,
  planWorkspaceStatusAssignment,
  selectMenuScopedMap,
  shouldContinueDeleteSiblingPositionRestore,
  shouldIgnoreNestedWorktreeContextMenuScope,
  shouldRemoveProjectFromContextMenu,
  shouldRevealWorktreeDeveloperMenu,
  shouldSuppressContextMenuFollowUpClick,
  shouldUseNativeContextMenu,
  type WorkspaceStatusAssignmentPlan
} from './worktree-context-menu-policy'
