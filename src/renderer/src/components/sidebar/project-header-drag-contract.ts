import type { PointerEvent } from 'react'

import type { ProjectHeaderDragBucketKey, ProjectHeaderDragRect } from './project-header-drop'
import type { Repo } from '../../../../shared/types'

export const EMPTY_HEADER_PREVIEW_OFFSETS: ReadonlyMap<string, number> = new Map()

export type RepoDragState = {
  draggingRepoId: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  dropPlaceholderY: number | null
  dropPlaceholderHeight: number
  previewOffsetsByRepoId: ReadonlyMap<string, number>
  // Pointer Y travel since the drag started, so the dragged header can follow
  // the cursor instead of only lifting in place. Null until the drag promotes.
  pointerOffsetY: number | null
  settling: boolean
}

export const INITIAL_REPO_DRAG_STATE: RepoDragState = {
  draggingRepoId: null,
  dropIndex: null,
  dropIndicatorY: null,
  dropPlaceholderY: null,
  dropPlaceholderHeight: 0,
  previewOffsetsByRepoId: EMPTY_HEADER_PREVIEW_OFFSETS,
  pointerOffsetY: null,
  settling: false
}

export type UseRepoHeaderDragArgs = {
  orderedRepoIds: string[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  repoById: ReadonlyMap<string, Repo>
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void | Promise<void>
  onCommitProjectGroupOrder: (
    repoId: string,
    projectGroupId: string | null,
    order: number
  ) => void | Promise<void>
  getScrollContainer: () => HTMLElement | null
}

export type RepoHeaderDragController = {
  state: RepoDragState
  onHandlePointerDown: (event: PointerEvent<HTMLElement>, repoId: string) => void
}

export type ProjectHeaderDragSession = {
  repoId: string
  bucketKey: ProjectHeaderDragBucketKey
  // Captured before the header lifts, so each displaced project makes room for
  // the whole expanded section rather than only its header.
  draggedSectionHeight: number
  sidebarRepoHeaderIds: readonly string[]
  pointerId: number
  headerRects: ProjectHeaderDragRect[]
  handleEl: HTMLElement
  startX: number
  startY: number
  startScrollTop: number
  latestPointerY: number
  promoted: boolean
}

/** Pointer travel since the drag started, in content space. The lifted header's
 *  transform is composed into the virtualizer's content-space offset, so a
 *  viewport-space delta would slide the header away from the pointer by the
 *  full distance of any mid-drag scroll — including this feature's autoscroll. */
export function getProjectHeaderDragPointerOffsetY(
  session: ProjectHeaderDragSession,
  container: HTMLElement | null
): number {
  const scrollTop = container?.scrollTop ?? session.startScrollTop
  return session.latestPointerY + scrollTop - (session.startY + session.startScrollTop)
}

// Why: preview offsets are rebuilt into a fresh Map on every pointer frame, so
// identity comparison would re-render the whole sidebar even when nothing moved.
export function haveSameHeaderPreviewOffsets(
  left: ReadonlyMap<string, number>,
  right: ReadonlyMap<string, number>
): boolean {
  if (left === right) {
    return true
  }
  if (left.size !== right.size) {
    return false
  }
  for (const [repoId, offset] of left) {
    if (right.get(repoId) !== offset) {
      return false
    }
  }
  return true
}

export const PROJECT_HEADER_DRAG_THRESHOLD_PX = 4
export const PROJECT_HEADER_DROP_SETTLE_MS = 150

const REPO_HEADER_DRAG_HANDLE_SELECTOR = '[data-repo-header-drag-handle]'

// Shared with project-group headers: both reuse ProjectHeaderActions markup.
export const REPO_HEADER_ACTION_SELECTOR =
  '[data-repo-header-actions], [data-repo-header-action], [data-repo-header-collapse-affordance], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function isProjectHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  // Why: the project icon renders as an <svg>, so pressing it makes the event
  // target an SVGElement (not an HTMLElement). Match Element so dragging by the
  // icon still arms the drag; closest/contains work on any Element.
  if (!(target instanceof Element)) {
    return false
  }
  const dragHandle = target.closest(REPO_HEADER_DRAG_HANDLE_SELECTOR)
  return dragHandle !== null && currentTarget.contains(dragHandle)
}

export function isRepoHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  // Why: an <svg> icon inside an action button is an SVGElement, so match
  // Element to still treat it as an action target and not arm a drag.
  if (!(target instanceof Element) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(REPO_HEADER_ACTION_SELECTOR) !== null
}
