import type { PointerEvent } from 'react'

import type { ProjectHeaderDragBucketKey, ProjectHeaderDragRect } from './project-header-drop'
import type { Repo } from '../../../../shared/types'
import { isHeaderDragHandleTarget } from './header-drag-target-predicates'

export type RepoDragState = {
  draggingRepoId: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  targetBucketKey: string | null
  /** Group to highlight as the drop target when dropping into a collapsed/empty
   *  group (in that case no drop line is drawn). */
  dropIntoGroupId: string | null
}

export const INITIAL_REPO_DRAG_STATE: RepoDragState = {
  draggingRepoId: null,
  dropIndex: null,
  dropIndicatorY: null,
  targetBucketKey: null,
  dropIntoGroupId: null
}

export type UseRepoHeaderDragArgs = {
  orderedRepoIds: string[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  repoById: ReadonlyMap<string, Repo>
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void
  onCommitProjectGroupOrder: (repoId: string, projectGroupId: string | null, order?: number) => void
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
  sidebarRepoHeaderIdsByBucketAll?: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
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

export function isProjectHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  return isHeaderDragHandleTarget(target, currentTarget, REPO_HEADER_DRAG_HANDLE_SELECTOR)
}
