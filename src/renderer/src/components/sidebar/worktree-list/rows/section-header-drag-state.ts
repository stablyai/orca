import {
  getRootProjectHeaderKey,
  getRootProjectHeaderOccurrenceKey
} from '../drag/root-project-header-drop'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import {
  getHeaderDragRepo,
  type GroupHeaderRow
} from '../../../../../../shared/sidebar-list/row-types'
import type { SectionHeaderRowContext } from './section-header-row-context'

/** Which project or project group a section header drags, and whether it can or is being dragged now. */
export function getSectionHeaderDragState(
  ctx: SectionHeaderRowContext,
  row: GroupHeaderRow,
  isRepoHeader: boolean,
  isProjectGroupHeader: boolean
) {
  const { headerDrag } = ctx
  const usesRootProjectDrag = Boolean(
    headerDrag.rootProjectHeaderKeys && (row.projectGroupDepth ?? 0) === 0
  )
  const headerRepo = isRepoHeader
    ? usesRootProjectDrag
      ? (row.anchorRepo ?? row.repo)
      : getHeaderDragRepo(row)
    : undefined
  const projectIdForHeader = headerRepo?.id
  const projectGroupIdForHeader =
    isProjectGroupHeader && !row.repo && typeof row.projectGroup?.id === 'string'
      ? row.projectGroup.id
      : undefined
  const projectGroupDragIdForHeader =
    row.repeated && !usesRootProjectDrag ? undefined : projectGroupIdForHeader
  // Why: rename/delete must route to the host that owns this row, not to whichever host has focus.
  const projectGroupHostIdForHeader =
    row.projectGroup && 'createdFrom' in row.projectGroup
      ? getRepoExecutionHostId(row.projectGroup)
      : undefined
  const repoHeaderIndex = headerRepo && headerDrag.repoHeaderIndexByRepoId.get(headerRepo.id)
  const repoHeaderBucketKey = headerRepo && headerDrag.repoHeaderBucketByRepoId.get(headerRepo.id)
  const projectGroupHeaderIndex =
    projectGroupDragIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderIndexByGroupId.get(projectGroupDragIdForHeader)
      : undefined
  const projectGroupHeaderBucketKey =
    projectGroupDragIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderBucketByGroupId.get(projectGroupDragIdForHeader)
      : undefined
  const rootProjectHeaderKey = usesRootProjectDrag ? getRootProjectHeaderKey(row) : undefined
  const rootProjectHeaderCount = rootProjectHeaderKey
    ? (headerDrag.rootProjectHeaderCountByOccurrenceKey.get(
        getRootProjectHeaderOccurrenceKey(rootProjectHeaderKey, row.hostId)
      ) ??
      headerDrag.rootProjectHeaderCountByOccurrenceKey.get(
        getRootProjectHeaderOccurrenceKey(rootProjectHeaderKey)
      ))
    : undefined
  const isDraggableRepoHeader = Boolean(
    headerDrag.canReorderRepoHeaders &&
    projectIdForHeader &&
    repoHeaderBucketKey &&
    (rootProjectHeaderCount !== undefined
      ? rootProjectHeaderCount > 1
      : (headerDrag.sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1)
  )
  const isDraggableProjectGroupHeader = Boolean(
    headerDrag.canReorderProjectGroupHeaders &&
    projectGroupDragIdForHeader &&
    projectGroupHeaderBucketKey &&
    (rootProjectHeaderCount !== undefined
      ? rootProjectHeaderCount > 1
      : (headerDrag.sidebarProjectGroupHeaderIdsByBucket.get(projectGroupHeaderBucketKey)?.length ??
          0) > 1)
  )
  const isDraggingThis =
    headerDrag.canReorderRepoHeaders &&
    headerDrag.repoDrag.state.draggingRepoId === projectIdForHeader
  const isDraggingThisProjectGroup =
    headerDrag.canReorderProjectGroupHeaders &&
    headerDrag.projectGroupDrag.state.draggingGroupId === projectGroupDragIdForHeader
  return {
    headerRepo,
    projectIdForHeader,
    projectGroupIdForHeader,
    projectGroupDragIdForHeader,
    projectGroupHostIdForHeader,
    repoHeaderIndex,
    repoHeaderBucketKey,
    projectGroupHeaderIndex,
    projectGroupHeaderBucketKey,
    rootProjectHeaderKey,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    isDraggingThis,
    isDraggingThisProjectGroup
  }
}
