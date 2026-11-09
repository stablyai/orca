import { useMemo } from 'react'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/host-section-rows'
import type { Row } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import {
  getHeaderSectionEndByRowIndex,
  getHeaderSectionEndIndexByRowIndex,
  getProjectGroupHeaderSectionEndByGroupId,
  getProjectGroupHeaderSectionEndIndexByGroupId,
  getRepoHeaderSectionEndByRepoId,
  getRepoHeaderSectionEndIndexByRepoId,
  getRootProjectHeaderSectionEndByKey
} from '../viewport/worktree-header-section-boundaries'
import { getSidebarOrderedRepoHeaderIdsByBucket } from './project-header-drop'
import { getSidebarOrderedProjectGroupHeaderIdsByBucket } from './project-group-header-drop'

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

export function useHeaderDragIndexing(args: {
  rows: readonly HostSectionRow[]
  renderRows: readonly RenderRow[]
  firstHeaderIndex: number
  projectGroups: readonly ProjectGroup[]
}) {
  const { rows, renderRows, firstHeaderIndex, projectGroups } = args
  const projectGroupByIdForHeaderDrag = useMemo(
    () => new Map(projectGroups.map((group) => [group.id, group])),
    [projectGroups]
  )
  // Why: an id shared by two hosts has no single owner, so leave it unrouted rather than guess.
  const projectGroupOwnerHostIdByGroupId = useMemo(() => {
    const byGroupId = new Map<string, ExecutionHostId | null>()
    for (const group of projectGroups) {
      const hostId = getRepoExecutionHostId(group)
      const existing = byGroupId.get(group.id)
      byGroupId.set(group.id, existing === undefined || existing === hostId ? hostId : null)
    }
    return byGroupId
  }, [projectGroups])

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
  const repoHeaderSectionEndIndexByRepoId = useMemo(
    () => getRepoHeaderSectionEndIndexByRepoId({ rows: renderRows }),
    [renderRows]
  )
  const projectGroupHeaderSectionEndIndexByGroupId = useMemo(
    () => getProjectGroupHeaderSectionEndIndexByGroupId({ rows: renderRows }),
    [renderRows]
  )
  const repoHeaderSectionEndByRepoId = useMemo(
    () =>
      getRepoHeaderSectionEndByRepoId({
        rows: renderRows,
        firstHeaderIndex
      }),
    [firstHeaderIndex, renderRows]
  )
  const projectGroupHeaderSectionEndByGroupId = useMemo(
    () =>
      getProjectGroupHeaderSectionEndByGroupId({
        rows: renderRows,
        firstHeaderIndex
      }),
    [firstHeaderIndex, renderRows]
  )
  const headerSectionEndIndexByRowIndex = useMemo(
    () => getHeaderSectionEndIndexByRowIndex({ rows: renderRows }),
    [renderRows]
  )
  const headerSectionEndByRowIndex = useMemo(
    () => getHeaderSectionEndByRowIndex({ rows: renderRows, firstHeaderIndex }),
    [firstHeaderIndex, renderRows]
  )
  const rootProjectHeaderSectionEndByKey = useMemo(
    () => getRootProjectHeaderSectionEndByKey(renderRows, firstHeaderIndex),
    [firstHeaderIndex, renderRows]
  )

  return {
    projectGroupByIdForHeaderDrag,
    projectGroupOwnerHostIdByGroupId,
    sidebarRepoHeaderIdsByBucket,
    sidebarProjectGroupHeaderIdsByBucket,
    repoHeaderIndexByRepoId,
    repoHeaderBucketByRepoId,
    projectGroupHeaderIndexByGroupId,
    projectGroupHeaderBucketByGroupId,
    headerSectionEndByRowIndex,
    headerSectionEndIndexByRowIndex,
    repoHeaderSectionEndByRepoId,
    repoHeaderSectionEndIndexByRepoId,
    projectGroupHeaderSectionEndByGroupId,
    projectGroupHeaderSectionEndIndexByGroupId,
    rootProjectHeaderSectionEndByKey
  }
}
