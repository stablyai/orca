import type { RootProjectHeaderDrag } from './root-project-header-drop'
import type { PointerEvent } from 'react'

import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { HostHeaderRect } from './host-header-drag-dom'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'
import type { ProjectGroupHeaderDragRect } from './project-group-header-drop'
import type { ProjectHeaderDragBucketKey, ProjectHeaderDragRect } from './project-header-drop'

export const ROOT_INTERLEAVED_PROJECT_BUCKET_KEY = 'root-interleaved'

export type RepoDragState = {
  draggingRepoId: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  dropTargetGroupId: string | null
  dropTargetCatalogHostId?: ExecutionHostId | null
}

export const INITIAL_REPO_DRAG_STATE: RepoDragState = {
  draggingRepoId: null,
  dropIndex: null,
  dropIndicatorY: null,
  dropTargetGroupId: null,
  dropTargetCatalogHostId: null
}

export type UseRepoHeaderDragArgs = RootProjectHeaderDrag & {
  orderedRepoIds: string[]
  sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  repoById: ReadonlyMap<string, Repo>
  projectGroupById?: ReadonlyMap<string, ProjectGroup>
  projectGroups: readonly ProjectGroup[]
  getLiveRepos: () => readonly Repo[]
  allowSlotReorder: boolean
  usesProjectGroupOrdering: boolean
  onCommitRepoOrder: (orderedIds: string[]) => void
  onCommitProjectGroupOrder: (
    project: Repo,
    projectGroupId: string | null,
    order: number
  ) => Promise<boolean> | boolean | void
  onCommitProjectGroupUpdate?: (
    groupId: string,
    updates: ProjectGroupHeaderUpdatePatch
  ) => Promise<boolean> | boolean | void
  onMoveToGroupHeader: (project: Repo, groupId: string) => void
  getScrollContainer: () => HTMLElement | null
}

export type RepoHeaderDragController = {
  state: RepoDragState
  onHandlePointerDown: (
    event: PointerEvent<HTMLElement>,
    repo: Repo,
    groupRepo?: Repo | null
  ) => void
}

export type ProjectHeaderDragSession = {
  // Why the row, not its id: a twin on another host shares the id.
  repo: Repo
  /** Host-localized registration for group membership; null when a merged header spans multiple hosts. */
  groupRepo?: Repo | null
  bucketKey: ProjectHeaderDragBucketKey
  sidebarRepoHeaderIds: readonly string[]
  rootProjectHeaderKeys?: readonly string[]
  rootProjectHeaderHostId?: string
  rootHeaderRects?: ProjectHeaderDragRect[]
  joinableGroupIds: ReadonlySet<string>
  hostHeaderRects?: HostHeaderRect[]
  pointerId: number
  headerRects: ProjectHeaderDragRect[]
  groupHeaderRects: ProjectGroupHeaderDragRect[]
  handleEl: HTMLElement
  startX: number
  startY: number
  latestPointerY: number
  promoted: boolean
}

export const PROJECT_HEADER_DRAG_THRESHOLD_PX = 4

const REPO_HEADER_DRAG_HANDLE_SELECTOR = '[data-repo-header-drag-handle]'

// Shared with project-group headers: both reuse ProjectHeaderActions markup.
export const REPO_HEADER_ACTION_SELECTOR =
  '[data-repo-header-actions], [data-repo-header-action], [data-repo-header-collapse-affordance], button, a, input, textarea, select, [contenteditable=""], [contenteditable="true"]'

export function isProjectHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  // SVG icons are Elements too; allow dragging by the project icon.
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
  // SVG action icons must not arm a header drag.
  if (!(target instanceof Element) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(REPO_HEADER_ACTION_SELECTOR) !== null
}
