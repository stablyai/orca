import type { PointerEvent } from 'react'

import type { ProjectHeaderDragBucketKey, ProjectHeaderDragRect } from './project-header-drop'
import type { Repo } from '../../../../shared/types'

export type RepoDragState = {
  draggingRepoId: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
}

export const INITIAL_REPO_DRAG_STATE: RepoDragState = {
  draggingRepoId: null,
  dropIndex: null,
  dropIndicatorY: null
}

export type UseRepoHeaderDragArgs = {
  orderedRepoIds: string[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  repoById: ReadonlyMap<string, Repo>
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void
  onCommitProjectGroupOrder: (repoId: string, projectGroupId: string | null, order: number) => void
  getScrollContainer: () => HTMLElement | null
}

export type RepoHeaderDragController = {
  state: RepoDragState
  onHandlePointerDown: (event: PointerEvent<HTMLElement>, repoId: string) => void
}

export type ProjectHeaderDragSession = {
  repoId: string
  bucketKey: ProjectHeaderDragBucketKey
  sidebarRepoHeaderIds: readonly string[]
  pointerId: number
  headerRects: ProjectHeaderDragRect[]
  handleEl: HTMLElement
  startX: number
  startY: number
  latestPointerY: number
  promoted: boolean
}

export const PROJECT_HEADER_DRAG_THRESHOLD_PX = 4

const REPO_HEADER_DRAG_HANDLE_SELECTOR = '[data-repo-header-drag-handle]'

const REPO_HEADER_ACTION_SELECTOR =
  '[data-repo-header-action], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function isProjectHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement)) {
    return false
  }
  const dragHandle = target.closest(REPO_HEADER_DRAG_HANDLE_SELECTOR)
  return dragHandle !== null && currentTarget.contains(dragHandle)
}

export function isRepoHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  if (!(target instanceof HTMLElement) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(REPO_HEADER_ACTION_SELECTOR) !== null
}
