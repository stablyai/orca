import type { SessionSourceEdit } from '../../session-source-edits'
import type { AppState } from '../../types'
import {
  findSiblingGroupId,
  removeGroupLayoutLeaf
} from '../../../../../shared/workspace-layout/tab-group-layout-tree'

type GroupLayoutState = Pick<AppState, 'layoutByWorktree' | 'activeGroupIdByWorktree'>

export function collapseGroupLayoutEdit(
  edit: SessionSourceEdit<GroupLayoutState>,
  worktreeId: string,
  groupId: string,
  fallbackGroupId?: string | null
): void {
  const currentLayout = edit.entry('layoutByWorktree', worktreeId)
  if (!currentLayout) {
    return
  }
  const siblingId = findSiblingGroupId(currentLayout, groupId)
  const collapsed = removeGroupLayoutLeaf(currentLayout, groupId)
  if (collapsed) {
    edit.set('layoutByWorktree', worktreeId, collapsed)
  } else {
    edit.remove('layoutByWorktree', worktreeId)
  }
  edit.set(
    'activeGroupIdByWorktree',
    worktreeId,
    siblingId ?? fallbackGroupId ?? edit.entry('activeGroupIdByWorktree', worktreeId)!
  )
}
