import { useEffect, useMemo } from 'react'
import type React from 'react'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type {
  HostHeaderRow,
  HostSectionRow
} from '../../../../../../shared/sidebar-list/host-section-rows'
import type { WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import { useHostHeaderDrag } from './host-header-drag'
import { useRepoHeaderDrag } from './project-header-drag'
import { useProjectGroupHeaderDrag } from './project-group-header-drag'
import {
  readLiveProjectGroups,
  readLiveRepos,
  useHeaderDragCommitActions
} from './use-header-drag-commit-actions'
import { useHeaderDragIndexing } from './use-header-drag-indexing'
import {
  getRootProjectHeaderCountByOccurrenceKey,
  getSidebarRootProjectHeaderKeys
} from './root-project-header-drop'

export type WorktreeSidebarHeaderDrag = ReturnType<typeof useWorktreeSidebarHeaderDrag>

export function useWorktreeSidebarHeaderDrag(args: {
  rows: HostSectionRow[]
  renderRows: readonly RenderRow[]
  firstHeaderIndex: number
  allRepoIds: string[]
  repoMap: Map<string, Repo>
  projectGroups: readonly ProjectGroup[]
  groupBy: WorktreeGroupBy
  projectOrderBy: ProjectOrderBy
  scrollRef: React.RefObject<HTMLDivElement | null>
  onReorderHostSections: (orderedHostIds: ExecutionHostId[]) => void
  onHostDragActiveChange: (active: boolean) => void
  suppressMeasurementAdjustmentUntilRef: React.MutableRefObject<number>
  directScrollInputUntilRef: React.MutableRefObject<number>
}) {
  const {
    rows,
    renderRows,
    firstHeaderIndex,
    allRepoIds,
    repoMap,
    projectGroups,
    groupBy,
    projectOrderBy,
    scrollRef,
    onReorderHostSections,
    onHostDragActiveChange,
    suppressMeasurementAdjustmentUntilRef,
    directScrollInputUntilRef
  } = args
  const hasProjectGroups = projectGroups.length > 0
  const canReorderRepoHeaders = groupBy === 'repo' && projectOrderBy === 'manual'
  const canDragRepoHeaders = groupBy === 'repo' && (projectOrderBy === 'manual' || hasProjectGroups)
  const canReorderProjectGroupHeaders = groupBy === 'repo' && hasProjectGroups
  const rootProjectHeaderKeys = useMemo(
    () =>
      hasProjectGroups
        ? getSidebarRootProjectHeaderKeys(
            projectOrderBy === 'recent'
              ? rows.filter(
                  (row) => row.type === 'host-header' || (row.type === 'header' && !row.repo)
                )
              : rows
          )
        : undefined,
    [hasProjectGroups, projectOrderBy, rows]
  )
  const rootProjectHeaderCountByOccurrenceKey = useMemo(
    () => getRootProjectHeaderCountByOccurrenceKey(rootProjectHeaderKeys),
    [rootProjectHeaderKeys]
  )
  const indexing = useHeaderDragIndexing({
    rows,
    renderRows,
    firstHeaderIndex,
    projectGroups,
    repoMap,
    rootProjectHeaderKeys,
    canDragRepoHeaders,
    canReorderRepoHeaders,
    canReorderProjectGroupHeaders
  })
  const commitActions = useHeaderDragCommitActions({
    allRepoIds,
    repoMap,
    projectGroupByIdForHeaderDrag: indexing.projectGroupByIdForHeaderDrag,
    projectGroupOwnerHostIdByGroupId: indexing.projectGroupOwnerHostIdByGroupId,
    sidebarProjectGroupHeaderIdsByBucket: indexing.sidebarProjectGroupHeaderIdsByBucket,
    sidebarGroupChildItemIdsByGroupId: indexing.sidebarGroupChildItemIdsByGroupId,
    suppressMeasurementAdjustmentUntilRef,
    directScrollInputUntilRef
  })

  const orderedHostIds = useMemo(
    () =>
      rows
        .filter((row): row is HostHeaderRow => row.type === 'host-header')
        .map((row) => row.hostId),
    [rows]
  )
  const hostDrag = useHostHeaderDrag({
    orderedHostIds,
    onCommit: onReorderHostSections,
    getScrollContainer: () => scrollRef.current
  })
  useEffect(() => {
    onHostDragActiveChange(hostDrag.state.draggingHostId !== null)
  }, [hostDrag.state.draggingHostId, onHostDragActiveChange])
  useEffect(() => () => onHostDragActiveChange(false), [onHostDragActiveChange])

  // Drag applies only in manual order; still construct the controller inert for stable hook order.
  const repoDrag = useRepoHeaderDrag({
    orderedRepoIds: allRepoIds,
    sidebarRepoHeaderIdsByBucket: indexing.sidebarRepoHeaderIdsByBucket,
    sidebarGroupChildItemIdsByGroupId: indexing.sidebarGroupChildItemIdsByGroupId,
    pinnedRepoHeaderIds: indexing.pinnedRepoHeaderIds,
    repoById: repoMap,
    projectGroupById: indexing.projectGroupByIdForHeaderDrag,
    projectGroups,
    getLiveRepos: readLiveRepos,
    allowSlotReorder: canReorderRepoHeaders,
    usesProjectGroupOrdering: hasProjectGroups,
    onCommitRepoOrder: commitActions.commitRepoReorder,
    onCommitProjectGroupOrder: commitActions.commitProjectGroupOrder,
    onCommitProjectGroupUpdate: commitActions.commitProjectGroupHeaderUpdate,
    onMoveToGroupHeader: commitActions.moveRepoToGroupHeader,
    rootProjectHeaderKeys,
    onCommitRootProjectOrder: commitActions.commitRootProjectOrder,
    getScrollContainer: () => scrollRef.current
  })
  const projectGroupDrag = useProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket: indexing.sidebarProjectGroupHeaderIdsByBucket,
    sidebarGroupChildItemIdsByGroupId: indexing.sidebarGroupChildItemIdsByGroupId,
    allowMixedProjectReorder: canReorderRepoHeaders,
    projectGroupById: indexing.projectGroupByIdForHeaderDrag,
    repoById: repoMap,
    pinnedRepoHeaderIds: indexing.pinnedRepoHeaderIds,
    orderedRepoIds: allRepoIds,
    projectGroupOwnerHostIdByGroupId: indexing.projectGroupOwnerHostIdByGroupId,
    getLiveRepos: readLiveRepos,
    getLiveProjectGroups: readLiveProjectGroups,
    rootProjectHeaderKeys,
    onCommitRootProjectOrder: commitActions.commitRootProjectOrder,
    onCommitProjectGroupUpdate: commitActions.commitProjectGroupHeaderUpdate,
    onCommitProjectGroupOrder: commitActions.commitProjectGroupOrder,
    getScrollContainer: () => scrollRef.current
  })
  return {
    rootProjectHeaderCountByOccurrenceKey,
    rootProjectHeaderSectionEndByKey: indexing.rootProjectHeaderSectionEndByKey,
    canReorderRepoHeaders,
    canDragRepoHeaders,
    canDragProjectHeader: indexing.canDragProjectHeader,
    canReorderProjectGroupHeaders,
    rootProjectHeaderKeys,
    canDragProjectGroupHeader: indexing.canDragProjectGroupHeader,
    moveProjectGroupToParent: commitActions.moveProjectGroupToParent,
    orderedHostIds,
    hostDrag,
    repoDrag,
    projectGroupDrag,
    sidebarRepoHeaderIdsByBucket: indexing.sidebarRepoHeaderIdsByBucket,
    sidebarProjectGroupHeaderIdsByBucket: indexing.sidebarProjectGroupHeaderIdsByBucket,
    repoHeaderIndexByRepoId: indexing.repoHeaderIndexByRepoId,
    repoHeaderBucketByRepoId: indexing.repoHeaderBucketByRepoId,
    projectGroupHeaderIndexByGroupId: indexing.projectGroupHeaderIndexByGroupId,
    projectGroupHeaderBucketByGroupId: indexing.projectGroupHeaderBucketByGroupId,
    headerSectionEndByRowIndex: indexing.headerSectionEndByRowIndex,
    headerSectionEndIndexByRowIndex: indexing.headerSectionEndIndexByRowIndex,
    repoHeaderSectionEndByRepoId: indexing.repoHeaderSectionEndByRepoId,
    repoHeaderSectionEndIndexByRepoId: indexing.repoHeaderSectionEndIndexByRepoId,
    projectGroupHeaderSectionEndByGroupId: indexing.projectGroupHeaderSectionEndByGroupId,
    projectGroupHeaderSectionEndIndexByGroupId: indexing.projectGroupHeaderSectionEndIndexByGroupId
  }
}
