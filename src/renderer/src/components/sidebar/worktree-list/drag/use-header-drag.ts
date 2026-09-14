import { useCallback, useEffect, useMemo } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import { getProjectGroupHostId } from '@/store/slices/project-group-owner-routing'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { HostHeaderRow, HostSectionRow } from '../../host-section-rows'
import type { Row, WorktreeGroupBy } from '../grouping/row-types'
import type { RenderRow } from '../listing/render-row'
import {
  getProjectGroupHeaderSectionEndByGroupId,
  getRepoHeaderSectionEndByRepoId
} from '../../worktree-header-section-boundaries'
import { useHostHeaderDrag } from '../../host-header-drag'
import { useRepoHeaderDrag } from '../../project-header-drag'
import { getSidebarOrderedRepoHeaderIdsByBucket } from '../../project-header-drop'
import { useProjectGroupHeaderDrag } from '../../project-group-header-drag'
import { getSidebarOrderedProjectGroupHeaderIdsByBucket } from '../../project-group-header-drop'
import { USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS } from '../viewport/use-scroll-suppression'

export type WorktreeSidebarHeaderDrag = ReturnType<typeof useWorktreeSidebarHeaderDrag>

function indexById(byBucket: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  const map = new Map<string, number>()
  for (const ids of byBucket.values()) {
    ids.forEach((id, index) => {
      map.set(id, index)
    })
  }
  return map
}

function bucketById(byBucket: ReadonlyMap<string, readonly string[]>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [bucketKey, ids] of byBucket) {
    for (const id of ids) {
      map.set(id, bucketKey)
    }
  }
  return map
}

// Reordering the three header tiers (host card, project group, project) plus the bucket
// bookkeeping their drag controllers and DOM attributes need.
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
  const reorderRepos = useAppStore((s) => s.reorderRepos)
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)
  const hasProjectGroups = projectGroups.length > 0
  const canReorderRepoHeaders = groupBy === 'repo' && projectOrderBy === 'manual'
  const canReorderProjectGroupHeaders = groupBy === 'repo' && hasProjectGroups
  const projectGroupByIdForHeaderDrag = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  )
  // Why: an id shared by two hosts has no single owner, so leave it unrouted rather than guess.
  const projectGroupOwnerHostIdByGroupId = useMemo(() => {
    const byGroupId = new Map<string, ExecutionHostId | null>()
    for (const group of projectGroups) {
      const hostId = getProjectGroupHostId(group)
      const existing = byGroupId.get(group.id)
      byGroupId.set(group.id, existing === undefined || existing === hostId ? hostId : null)
    }
    return byGroupId
  }, [projectGroups])

  // Why: reorder keeps scrollTop stable; flag direct scroll input so anchor-restore won't chase the moved row (jumpy drop).
  const suppressScrollCorrectionForHeaderCommit = useCallback(() => {
    const suppressUntil = window.performance.now() + USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS
    suppressMeasurementAdjustmentUntilRef.current = suppressUntil
    directScrollInputUntilRef.current = suppressUntil
  }, [directScrollInputUntilRef, suppressMeasurementAdjustmentUntilRef])
  const commitRepoReorder = useCallback(
    (orderedIds: string[]) => {
      suppressScrollCorrectionForHeaderCommit()
      reorderRepos(orderedIds)
    },
    [reorderRepos, suppressScrollCorrectionForHeaderCommit]
  )
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

  const sidebarRepoHeaderIdsByBucket = useMemo(
    () =>
      getSidebarOrderedRepoHeaderIdsByBucket(
        rows.filter((row): row is Row => row.type !== 'host-header')
      ),
    [rows]
  )
  const sidebarProjectGroupHeaderIdsByBucket = useMemo(
    () =>
      getSidebarOrderedProjectGroupHeaderIdsByBucket(
        rows.filter((row): row is Row => row.type !== 'host-header'),
        projectGroupByIdForHeaderDrag
      ),
    [projectGroupByIdForHeaderDrag, rows]
  )
  const repoHeaderIndexByRepoId = useMemo(
    () => indexById(sidebarRepoHeaderIdsByBucket),
    [sidebarRepoHeaderIdsByBucket]
  )
  const repoHeaderBucketByRepoId = useMemo(
    () => bucketById(sidebarRepoHeaderIdsByBucket),
    [sidebarRepoHeaderIdsByBucket]
  )
  const projectGroupHeaderIndexByGroupId = useMemo(
    () => indexById(sidebarProjectGroupHeaderIdsByBucket),
    [sidebarProjectGroupHeaderIdsByBucket]
  )
  const projectGroupHeaderBucketByGroupId = useMemo(
    () => bucketById(sidebarProjectGroupHeaderIdsByBucket),
    [sidebarProjectGroupHeaderIdsByBucket]
  )
  const commitProjectGroupOrder = useCallback(
    (repoId: string, projectGroupId: string | null, order: number) => {
      void moveProjectToGroup(repoId, projectGroupId, order)
    },
    [moveProjectToGroup]
  )
  const commitProjectGroupHeaderOrder = useCallback(
    (groupId: string, tabOrder: number) => {
      if (!Number.isFinite(tabOrder)) {
        return
      }
      suppressScrollCorrectionForHeaderCommit()
      // Why: manual order persists on the group's own host; the focused host may not hold this row.
      const ownerHostId = projectGroupOwnerHostIdByGroupId.get(groupId)
      void updateProjectGroup(groupId, { tabOrder }, { hostId: ownerHostId ?? undefined })
    },
    [projectGroupOwnerHostIdByGroupId, suppressScrollCorrectionForHeaderCommit, updateProjectGroup]
  )
  // Drag applies only in manual order; still construct the controller inert for stable hook order.
  const repoDrag = useRepoHeaderDrag({
    orderedRepoIds: allRepoIds,
    sidebarRepoHeaderIdsByBucket,
    repoById: repoMap,
    usesProjectGroupOrdering: hasProjectGroups,
    onCommitRepoOrder: commitRepoReorder,
    onCommitProjectGroupOrder: commitProjectGroupOrder,
    getScrollContainer: () => scrollRef.current
  })
  const projectGroupDrag = useProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket,
    projectGroupById: projectGroupByIdForHeaderDrag,
    onCommitProjectGroupTabOrder: commitProjectGroupHeaderOrder,
    getScrollContainer: () => scrollRef.current
  })
  const repoHeaderSectionEndByRepoId = useMemo(
    () =>
      getRepoHeaderSectionEndByRepoId({
        rows: renderRows,
        firstHeaderIndex,
        sidebarRepoHeaderIdsByBucket,
        repoHeaderBucketByRepoId
      }),
    [firstHeaderIndex, renderRows, repoHeaderBucketByRepoId, sidebarRepoHeaderIdsByBucket]
  )
  const projectGroupHeaderSectionEndByGroupId = useMemo(
    () =>
      getProjectGroupHeaderSectionEndByGroupId({
        rows: renderRows,
        firstHeaderIndex,
        sidebarProjectGroupHeaderIdsByBucket,
        projectGroupHeaderBucketByGroupId
      }),
    [
      firstHeaderIndex,
      projectGroupHeaderBucketByGroupId,
      renderRows,
      sidebarProjectGroupHeaderIdsByBucket
    ]
  )

  return {
    canReorderRepoHeaders,
    canReorderProjectGroupHeaders,
    orderedHostIds,
    hostDrag,
    repoDrag,
    projectGroupDrag,
    sidebarRepoHeaderIdsByBucket,
    sidebarProjectGroupHeaderIdsByBucket,
    repoHeaderIndexByRepoId,
    repoHeaderBucketByRepoId,
    projectGroupHeaderIndexByGroupId,
    projectGroupHeaderBucketByGroupId,
    repoHeaderSectionEndByRepoId,
    projectGroupHeaderSectionEndByGroupId
  }
}
