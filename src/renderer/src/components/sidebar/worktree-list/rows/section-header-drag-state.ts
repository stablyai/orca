import { getRootProjectHeaderOccurrenceKey } from '../drag/root-project-header-drop'
import type { SectionHeaderRowContext } from './section-header-row-context'

/** Where a header sits in its drag bucket and whether it can be, or is being, dragged. */
export function getSectionHeaderDragState(
  headerDrag: SectionHeaderRowContext['headerDrag'],
  {
    rootProjectHeaderKey,
    projectIdForHeader,
    projectGroupDragIdForHeader,
    hostId
  }: {
    rootProjectHeaderKey: string | undefined
    projectIdForHeader: string | undefined
    projectGroupDragIdForHeader: string | undefined
    hostId: string | undefined
  }
) {
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
  const rootProjectHeaderCount = rootProjectHeaderKey
    ? (headerDrag.rootProjectHeaderCountByOccurrenceKey.get(
        getRootProjectHeaderOccurrenceKey(rootProjectHeaderKey, hostId)
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
  const rootProjectHeaderSectionEnd = rootProjectHeaderKey
    ? headerDrag.rootProjectHeaderSectionEndByKey.get(
        getRootProjectHeaderOccurrenceKey(rootProjectHeaderKey, hostId)
      )
    : undefined
  return {
    repoHeaderIndex,
    repoHeaderBucketKey,
    projectGroupHeaderIndex,
    projectGroupHeaderBucketKey,
    rootProjectHeaderSectionEnd,
    isDraggableRepoHeader,
    isDraggableProjectGroupHeader,
    isDraggingThis,
    isDraggingThisProjectGroup
  }
}
