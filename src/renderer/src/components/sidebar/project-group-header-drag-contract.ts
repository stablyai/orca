import type { PointerEvent } from 'react'

import type {
  ProjectGroupHeaderDragBucketKey,
  ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import type { ProjectGroup } from '../../../../shared/types'

export type ProjectGroupDragState = {
  draggingGroupId: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
}

export const INITIAL_PROJECT_GROUP_DRAG_STATE: ProjectGroupDragState = {
  draggingGroupId: null,
  dropIndex: null,
  dropIndicatorY: null
}

export type UseProjectGroupHeaderDragArgs = {
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  onCommitProjectGroupTabOrder: (groupId: string, tabOrder: number) => void
  getScrollContainer: () => HTMLElement | null
}

export type ProjectGroupHeaderDragController = {
  state: ProjectGroupDragState
  onHandlePointerDown: (event: PointerEvent<HTMLElement>, groupId: string) => void
}

export type ProjectGroupHeaderDragSession = {
  groupId: string
  bucketKey: ProjectGroupHeaderDragBucketKey
  sidebarProjectGroupHeaderIds: readonly string[]
  pointerId: number
  headerRects: ProjectGroupHeaderDragRect[]
  handleEl: HTMLElement
  startX: number
  startY: number
  latestPointerY: number
  promoted: boolean
}

export const PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX = 4

const PROJECT_GROUP_HEADER_DRAG_HANDLE_SELECTOR = '[data-project-group-header-drag-handle]'

const PROJECT_GROUP_HEADER_ACTION_SELECTOR =
  '[data-repo-header-action], [data-repo-header-collapse-affordance], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function isProjectGroupHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const dragHandle = target.closest(PROJECT_GROUP_HEADER_DRAG_HANDLE_SELECTOR)
  return dragHandle !== null && currentTarget.contains(dragHandle)
}

export function isProjectGroupHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false
  }
  return (
    currentTarget.contains(target) && target.closest(PROJECT_GROUP_HEADER_ACTION_SELECTOR) !== null
  )
}
