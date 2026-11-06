import type { Repo } from '../../../../../../shared/repo-types'
import {
  getHeaderDragRepo,
  type GroupHeaderRow
} from '../../../../../../shared/sidebar-list/row-types'
import type { WorktreeSidebarHeaderDrag } from '../drag/use-header-drag'

export type SectionHeaderDragState = {
  headerRepo: Repo | undefined
  projectIdForHeader: string | undefined
  projectGroupIdForHeader: string | undefined
  projectGroupDragIdForHeader: string | undefined
  repoHeaderIndex: number | undefined
  repoHeaderBucketKey: string | undefined
  projectGroupHeaderIndex: number | undefined
  projectGroupHeaderBucketKey: string | undefined
  isDraggableRepoHeader: boolean
  isDraggableProjectGroupHeader: boolean
  isDraggingThis: boolean
  isDraggingThisProjectGroup: boolean
}

/** Drag identity for a repo or project-group header; repeated host copies never drag. */
export function resolveSectionHeaderDragState(args: {
  row: GroupHeaderRow
  headerDrag: WorktreeSidebarHeaderDrag
  isRepoHeader: boolean
  isProjectGroupHeader: boolean
}): SectionHeaderDragState {
  const { row, headerDrag, isRepoHeader, isProjectGroupHeader } = args
  // Drag keys on the project's anchor and skips copies an earlier host section already drew.
  const headerRepo = isRepoHeader ? getHeaderDragRepo(row) : undefined
  const projectIdForHeader = headerRepo?.id
  const projectGroupIdForHeader =
    isProjectGroupHeader && !row.repo && typeof row.projectGroup?.id === 'string'
      ? row.projectGroup.id
      : undefined
  const projectGroupDragIdForHeader = row.repeated ? undefined : projectGroupIdForHeader
  const repoHeaderIndex =
    projectIdForHeader !== undefined
      ? headerDrag.repoHeaderIndexByRepoId.get(projectIdForHeader)
      : undefined
  const repoHeaderBucketKey =
    projectIdForHeader !== undefined
      ? headerDrag.repoHeaderBucketByRepoId.get(projectIdForHeader)
      : undefined
  const projectGroupHeaderIndex =
    projectGroupDragIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderIndexByGroupId.get(projectGroupDragIdForHeader)
      : undefined
  const projectGroupHeaderBucketKey =
    projectGroupDragIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderBucketByGroupId.get(projectGroupDragIdForHeader)
      : undefined
  const isDraggableRepoHeader = Boolean(
    headerDrag.canReorderRepoHeaders &&
    isRepoHeader &&
    projectIdForHeader &&
    repoHeaderBucketKey &&
    (headerDrag.sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1
  )
  const isDraggableProjectGroupHeader = Boolean(
    headerDrag.canReorderProjectGroupHeaders &&
    projectGroupDragIdForHeader &&
    projectGroupHeaderBucketKey &&
    (headerDrag.sidebarProjectGroupHeaderIdsByBucket.get(projectGroupHeaderBucketKey)?.length ??
      0) > 1
  )
  const isDraggingThis =
    headerDrag.canReorderRepoHeaders &&
    headerDrag.repoDrag.state.draggingRepoId !== null &&
    headerDrag.repoDrag.state.draggingRepoId === projectIdForHeader
  const isDraggingThisProjectGroup =
    headerDrag.canReorderProjectGroupHeaders &&
    headerDrag.projectGroupDrag.state.draggingGroupId !== null &&
    headerDrag.projectGroupDrag.state.draggingGroupId === projectGroupDragIdForHeader
  return {
    headerRepo,
    projectIdForHeader,
    projectGroupIdForHeader,
    projectGroupDragIdForHeader,
    repoHeaderIndex,
    repoHeaderBucketKey,
    projectGroupHeaderIndex,
    projectGroupHeaderBucketKey,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    isDraggingThis,
    isDraggingThisProjectGroup
  }
}
