// group-header-drag-contract.ts
import type { PointerEvent } from 'react'

import type { GroupHeaderDragRect } from './group-header-drop'
import type { ProjectGroup } from '../../../../shared/types'

export type GroupDragState = {
  draggingGroupId: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
}

export const INITIAL_GROUP_DRAG_STATE: GroupDragState = {
  draggingGroupId: null,
  dropIndex: null,
  dropIndicatorY: null
}

export const GROUP_HEADER_DRAG_THRESHOLD_PX = 4

export type GroupHeaderDragSession = {
  groupId: string
  parentGroupId: string | null
  siblingGroupIds: readonly string[]
  pointerId: number
  headerRects: GroupHeaderDragRect[]
  handleEl: HTMLElement
  startX: number
  startY: number
  latestPointerY: number
  promoted: boolean
}

export type UseGroupHeaderDragArgs = {
  groupsById: ReadonlyMap<string, ProjectGroup>
  siblingGroupIdsByParent: ReadonlyMap<string | null, readonly string[]>
  onCommitGroupOrder: (groupId: string, tabOrder: number) => void
  getScrollContainer: () => HTMLElement | null
}

export type GroupHeaderDragController = {
  state: GroupDragState
  onHandlePointerDown: (event: PointerEvent<HTMLElement>, groupId: string) => void
}

const GROUP_HEADER_DRAG_HANDLE_SELECTOR = '[data-group-header-drag-handle]'

const GROUP_HEADER_ACTION_SELECTOR =
  '[data-repo-header-action], [data-repo-header-collapse-affordance], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function isGroupHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const dragHandle = target.closest(GROUP_HEADER_DRAG_HANDLE_SELECTOR)
  return dragHandle !== null && currentTarget.contains(dragHandle)
}

export function isGroupHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(GROUP_HEADER_ACTION_SELECTOR) !== null
}
