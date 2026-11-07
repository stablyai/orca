import type { SectionHeaderRowContext } from './SectionHeader'

/** Where a header sits in its drag bucket and whether it can be, or is being, dragged. */
export function getSectionHeaderDragState(
  headerDrag: SectionHeaderRowContext['headerDrag'],
  {
    isRepoHeader,
    projectIdForHeader,
    projectGroupDragIdForHeader
  }: {
    isRepoHeader: boolean
    projectIdForHeader: string | undefined
    projectGroupDragIdForHeader: string | undefined
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
