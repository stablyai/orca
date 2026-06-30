// group-header-drag-contract.ts
import type { PointerEvent } from 'react'

import type { GroupHeaderDragRect } from './group-header-drop'
import type { ProjectGroup } from '../../../../shared/types'
import { isHeaderDragHandleTarget, isHeaderActionTarget } from './header-drag-target-predicates'

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

export function isGroupHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  return isHeaderDragHandleTarget(target, currentTarget, GROUP_HEADER_DRAG_HANDLE_SELECTOR)
}

export function isGroupHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  return isHeaderActionTarget(target, currentTarget)
}
