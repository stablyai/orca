import { useCallback, useMemo } from 'react'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
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
import {
  filterRootProjectHeaderKeysByPinTier,
  getSidebarPinnedRepoHeaderIds,
  isRepoHeaderIdPinned
} from './header-drag-pin-tier'
import { getSidebarOrderedGroupChildItemIdsByGroupId } from './project-group-child-slot-order'
import {
  getProjectHeaderDragBucketKey,
  getSidebarOrderedRepoHeaderIdsByBucket
} from './project-header-drop'
import { canRepoStartHeaderDrag, getJoinableGroupIdsForRepo } from './project-header-group-drop'
import {
  getProjectGroupHeaderDragBucketKey,
  getSidebarOrderedProjectGroupHeaderIdsByBucket
} from './project-group-header-drop'
import {
  canProjectGroupStartHeaderDrag,
  getReparentableTargetGroupIdsForGroup
} from './project-group-header-reparent-drop'
import { getRootProjectHeaderDragKeys } from './root-project-header-drop'

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
  repoMap: ReadonlyMap<string, Repo>
  rootProjectHeaderKeys?: readonly string[]
  canDragRepoHeaders: boolean
  canReorderRepoHeaders: boolean
  canReorderProjectGroupHeaders: boolean
}) {
  const {
    rows,
    renderRows,
    firstHeaderIndex,
    projectGroups,
    repoMap,
    rootProjectHeaderKeys,
    canDragRepoHeaders,
    canReorderRepoHeaders,
    canReorderProjectGroupHeaders
  } = args
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
  const pinnedRepoHeaderIds = useMemo(
    () =>
      getSidebarPinnedRepoHeaderIds(rows.filter((row): row is Row => row.type !== 'host-header')),
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
  const sidebarGroupChildItemIdsByGroupId = useMemo(
    () =>
      getSidebarOrderedGroupChildItemIdsByGroupId(
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
    () => getRepoHeaderSectionEndByRepoId({ rows: renderRows, firstHeaderIndex }),
    [firstHeaderIndex, renderRows]
  )
  const projectGroupHeaderSectionEndByGroupId = useMemo(
    () => getProjectGroupHeaderSectionEndByGroupId({ rows: renderRows, firstHeaderIndex }),
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

  const canDragProjectHeader = useCallback(
    (repo: Repo, groupRepo?: Repo | null, hostId?: string) => {
      if (!canDragRepoHeaders) {
        return false
      }
      const effectiveGroupRepo = groupRepo === undefined ? repo : groupRepo
      const bucketOwnerRepo = effectiveGroupRepo ?? repo
      const bucketKey = getProjectHeaderDragBucketKey(bucketOwnerRepo)
      const bucketHeaderIds = sidebarRepoHeaderIdsByBucket.get(bucketKey) ?? []
      const draggedPinned =
        isRepoHeaderIdPinned(repo.id, pinnedRepoHeaderIds, repoMap) ||
        bucketOwnerRepo.isPinned === true
      const rootHeaderKeys =
        bucketKey === 'ungrouped' && rootProjectHeaderKeys
          ? filterRootProjectHeaderKeysByPinTier({
              keys: getRootProjectHeaderDragKeys(rootProjectHeaderKeys, `repo:${repo.id}`, hostId),
              isPinned: draggedPinned,
              projectGroupById: projectGroupByIdForHeaderDrag,
              pinnedRepoHeaderIds,
              repoById: repoMap
            })
          : undefined
      if (canReorderRepoHeaders && (rootHeaderKeys?.length ?? 0) > 1) {
        return true
      }
      return canRepoStartHeaderDrag({
        repo: bucketOwnerRepo,
        allowSlotReorder: canReorderRepoHeaders,
        bucketItemCount: bucketHeaderIds.length,
        bucketHeaderIds,
        pinnedRepoHeaderIds,
        repoById: repoMap,
        joinableGroupIds: effectiveGroupRepo
          ? getJoinableGroupIdsForRepo(effectiveGroupRepo, projectGroups)
          : new Set<string>()
      })
    },
    [
      canDragRepoHeaders,
      canReorderRepoHeaders,
      pinnedRepoHeaderIds,
      projectGroupByIdForHeaderDrag,
      projectGroups,
      repoMap,
      rootProjectHeaderKeys,
      sidebarRepoHeaderIdsByBucket
    ]
  )
  const canDragProjectGroupHeader = useCallback(
    (groupId: string, hostId?: string) => {
      if (!canReorderProjectGroupHeaders) {
        return false
      }
      const ownerHostId = projectGroupOwnerHostIdByGroupId.get(groupId)
      if (!ownerHostId) {
        return false
      }
      const group = projectGroupByIdForHeaderDrag.get(groupId)
      if (!group) {
        return false
      }
      const bucketKey = getProjectGroupHeaderDragBucketKey(group, projectGroupByIdForHeaderDrag)
      const rootProjectHeaderCount =
        bucketKey === 'root' && rootProjectHeaderKeys
          ? filterRootProjectHeaderKeysByPinTier({
              keys: getRootProjectHeaderDragKeys(
                rootProjectHeaderKeys,
                `group:${groupId}`,
                hostId ?? ownerHostId
              ),
              isPinned: group.isPinned === true,
              projectGroupById: projectGroupByIdForHeaderDrag,
              pinnedRepoHeaderIds,
              repoById: repoMap
            })?.length
          : undefined
      return canProjectGroupStartHeaderDrag({
        group,
        projectGroupById: projectGroupByIdForHeaderDrag,
        sidebarBucketHeaderIds: sidebarProjectGroupHeaderIdsByBucket.get(bucketKey) ?? [],
        rootProjectHeaderCount,
        reparentableGroupIds: getReparentableTargetGroupIdsForGroup(group, projectGroups)
      })
    },
    [
      canReorderProjectGroupHeaders,
      pinnedRepoHeaderIds,
      projectGroupByIdForHeaderDrag,
      projectGroupOwnerHostIdByGroupId,
      projectGroups,
      repoMap,
      rootProjectHeaderKeys,
      sidebarProjectGroupHeaderIdsByBucket
    ]
  )

  return {
    canDragProjectHeader,
    canDragProjectGroupHeader,
    projectGroupByIdForHeaderDrag,
    projectGroupOwnerHostIdByGroupId,
    sidebarRepoHeaderIdsByBucket,
    pinnedRepoHeaderIds,
    sidebarProjectGroupHeaderIdsByBucket,
    sidebarGroupChildItemIdsByGroupId,
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
