import type { RootProjectHeaderDrag } from './root-project-header-drop'
import type { PointerEvent } from 'react'

import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { HostHeaderRect } from './host-header-drag-dom'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'
import type {
  ProjectGroupHeaderDragBucketKey,
  ProjectGroupHeaderDragRect
} from './project-group-header-drop'
import { REPO_HEADER_ACTION_SELECTOR } from './project-header-drag-contract'
import type { ProjectHeaderDragRect } from './project-header-drop'

export const ROOT_INTERLEAVED_GROUP_BUCKET_KEY = 'root-interleaved'

export type ProjectGroupDragState = {
  draggingGroupId: string | null
  dropIndex: number | null
  dropIndicatorY: number | null
  dropTargetGroupId: string | null
  dropTargetCatalogHostId: ExecutionHostId | null
}

export const INITIAL_PROJECT_GROUP_DRAG_STATE: ProjectGroupDragState = {
  draggingGroupId: null,
  dropIndex: null,
  dropIndicatorY: null,
  dropTargetGroupId: null,
  dropTargetCatalogHostId: null
}

export type ProjectGroupHeaderUpdatePatch = {
  tabOrder?: number
  parentGroupId?: string | null
  rootProjectOrder?: number | null
}

export type UseProjectGroupHeaderDragArgs = RootProjectHeaderDrag & {
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  allowMixedProjectReorder?: boolean
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  orderedRepoIds?: readonly string[]
  projectGroupOwnerHostIdByGroupId?: ReadonlyMap<string, ExecutionHostId | null>
  getLiveRepos?: () => readonly Repo[]
  getLiveProjectGroups?: () => readonly ProjectGroup[]
  onCommitProjectGroupUpdate: (
    groupId: string,
    updates: ProjectGroupHeaderUpdatePatch
  ) => Promise<boolean> | boolean | void
  onCommitProjectGroupOrder?: (
    project: Repo,
    projectGroupId: string | null,
    order: number
  ) => Promise<boolean> | boolean | void
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
  rootProjectHeaderKeys?: readonly string[]
  rootProjectHeaderHostId?: string
  rootHeaderRects?: ProjectGroupHeaderDragRect[]
  reparentableGroupIds: ReadonlySet<string>
  pointerId: number
  headerRects: ProjectGroupHeaderDragRect[]
  repoHeaderRects?: ProjectHeaderDragRect[]
  hostHeaderRects: HostHeaderRect[]
  handleEl: HTMLElement
  startX: number
  startY: number
  latestPointerY: number
  promoted: boolean
}

export const PROJECT_GROUP_HEADER_DRAG_THRESHOLD_PX = 4

const PROJECT_GROUP_HEADER_DRAG_HANDLE_SELECTOR = '[data-project-group-header-drag-handle]'

export function isProjectGroupHeaderDragHandleTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  // SVG icons are Elements too; allow dragging by the group icon.
  if (!(target instanceof Element)) {
    return false
  }
  const dragHandle = target.closest(PROJECT_GROUP_HEADER_DRAG_HANDLE_SELECTOR)
  return dragHandle !== null && currentTarget.contains(dragHandle)
}

export function isProjectGroupHeaderActionTarget(
  target: EventTarget | null,
  currentTarget: HTMLElement
): boolean {
  // SVG action icons must not arm a header drag.
  if (!(target instanceof Element) || target === currentTarget) {
    return false
  }
  return currentTarget.contains(target) && target.closest(REPO_HEADER_ACTION_SELECTOR) !== null
}
