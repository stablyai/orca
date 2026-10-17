import type { WorktreeSidebarHeaderDrag } from '../drag/use-header-drag'

/** Everything one section header row needs to render its reorder affordances. */
export type SectionHeaderReorderState = {
  repoHeaderIndex: number | undefined
  repoHeaderBucketKey: string | undefined
  projectGroupHeaderIndex: number | undefined
  projectGroupHeaderBucketKey: string | undefined
  isDraggableRepoHeader: boolean
  isDraggableProjectGroupHeader: boolean
  isDraggingThis: boolean
  isDraggingThisProjectGroup: boolean
}

/** A lone header in its bucket has nothing to reorder against, so it never arms drag. */
export function getSectionHeaderReorderState(args: {
  headerDrag: WorktreeSidebarHeaderDrag
  isRepoHeader: boolean
  projectIdForHeader: string | undefined
  projectGroupIdForHeader: string | undefined
}): SectionHeaderReorderState {
  const { headerDrag, isRepoHeader, projectIdForHeader, projectGroupIdForHeader } = args
  const repoHeaderBucketKey =
    projectIdForHeader !== undefined
      ? headerDrag.repoHeaderBucketByRepoId.get(projectIdForHeader)
      : undefined
  const projectGroupHeaderBucketKey =
    projectGroupIdForHeader !== undefined
      ? headerDrag.projectGroupHeaderBucketByGroupId.get(projectGroupIdForHeader)
      : undefined
  return {
    repoHeaderIndex:
      projectIdForHeader !== undefined
        ? headerDrag.repoHeaderIndexByRepoId.get(projectIdForHeader)
        : undefined,
    repoHeaderBucketKey,
    projectGroupHeaderIndex:
      projectGroupIdForHeader !== undefined
        ? headerDrag.projectGroupHeaderIndexByGroupId.get(projectGroupIdForHeader)
        : undefined,
    projectGroupHeaderBucketKey,
    isDraggableRepoHeader: Boolean(
      headerDrag.canReorderRepoHeaders &&
      isRepoHeader &&
      projectIdForHeader &&
      repoHeaderBucketKey &&
      (headerDrag.sidebarRepoHeaderIdsByBucket.get(repoHeaderBucketKey)?.length ?? 0) > 1
    ),
    isDraggableProjectGroupHeader: Boolean(
      headerDrag.canReorderProjectGroupHeaders &&
      projectGroupIdForHeader &&
      projectGroupHeaderBucketKey &&
      (headerDrag.sidebarProjectGroupHeaderIdsByBucket.get(projectGroupHeaderBucketKey)?.length ??
        0) > 1
    ),
    isDraggingThis:
      headerDrag.canReorderRepoHeaders &&
      headerDrag.repoDrag.state.draggingRepoId !== null &&
      headerDrag.repoDrag.state.draggingRepoId === projectIdForHeader,
    isDraggingThisProjectGroup:
      headerDrag.canReorderProjectGroupHeaders &&
      headerDrag.projectGroupDrag.state.draggingGroupId !== null &&
      headerDrag.projectGroupDrag.state.draggingGroupId === projectGroupIdForHeader
  }
}
