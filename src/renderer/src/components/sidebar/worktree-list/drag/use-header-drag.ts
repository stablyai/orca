import { enqueueRootProjectOrderForSidebarDrop } from './root-project-order-commit'
import { useCallback, useEffect, useMemo } from 'react'
import type React from 'react'
import { useAppStore } from '@/store'
import '@/store/project-groups/project-group-owner-routing'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { ProjectOrderBy } from '../../../../../../shared/ui-chrome/ui-chrome-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { HostSectionRow } from '../../../../../../shared/sidebar-list/hosts/host-section-rows'
import type { Row, WorktreeGroupBy } from '../../../../../../shared/sidebar-list/row-types'
import type { RenderRow } from '../listing/render-row'
import {
  getProjectGroupHeaderSectionEndByGroupId,
  getRootProjectHeaderSectionEndByKey,
  getRepoHeaderSectionEndByRepoId
} from '../viewport/worktree-header-section-boundaries'
import { useHostHeaderDrag } from './host-header-drag'
import { useRepoHeaderDrag } from './project-header-drag'
import { getSidebarOrderedRepoHeaderIdsByBucket } from './project-header-drop'
import { useProjectGroupHeaderDrag } from './project-group-header-drag'
import { getSidebarOrderedProjectGroupHeaderIdsByBucket } from './project-group-header-drop'
import {
  getRootProjectHeaderCountByOccurrenceKey,
  getSidebarRootProjectHeaderKeys
} from './root-project-header-drop'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

const getAppStoreState = (): ReturnType<typeof useAppStore.getState> => useAppStore.getState()
const readLiveRepos = (): readonly Repo[] => getAppStoreState().repos

const EMPTY_BUCKET_MAP = new Map<string, string[]>()
const EMPTY_INDEX_MAP = new Map<string, number>()
const EMPTY_STRING_MAP = new Map<string, string>()
const EMPTY_PROJECT_GROUP_MAP = new Map<string, ProjectGroup>()
const EMPTY_OWNER_HOST_MAP = new Map<string, ExecutionHostId | null>()

export type WorktreeSidebarHeaderDrag = ReturnType<typeof useWorktreeSidebarHeaderDrag>

function indexById(byBucket: ReadonlyMap<string, readonly string[]>): Map<string, number> {
  if (byBucket.size === 0) {
    return EMPTY_INDEX_MAP
  }
  const map = new Map<string, number>()
  for (const ids of byBucket.values()) {
    ids.forEach((id, index) => {
      map.set(id, index)
    })
  }
  return map
}

function bucketById(byBucket: ReadonlyMap<string, readonly string[]>): Map<string, string> {
  if (byBucket.size === 0) {
    return EMPTY_STRING_MAP
  }
  const map = new Map<string, string>()
  for (const [bucketKey, ids] of byBucket) {
    for (const id of ids) {
      map.set(id, bucketKey)
    }
  }
  return map
}

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
  onScrollIntent: () => void
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
    onScrollIntent
  } = args
  const { reorderRepos, moveProjectToGroup, updateProjectGroup } = getAppStoreState()
  const hasProjectGroups = projectGroups.length > 0
  const canReorderRepoHeaders = groupBy === 'repo' && projectOrderBy === 'manual'
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
  const projectGroupByIdForHeaderDrag = useMemo(
    () =>
      hasProjectGroups
        ? new Map(projectGroups.map((group) => [group.id, group]))
        : EMPTY_PROJECT_GROUP_MAP,
    [hasProjectGroups, projectGroups]
  )
  const rootProjectHeaderCountByOccurrenceKey = useMemo(
    () => getRootProjectHeaderCountByOccurrenceKey(rootProjectHeaderKeys),
    [rootProjectHeaderKeys]
  )
  // Why: an id shared by two hosts has no single owner, so leave it unrouted rather than guess.
  const projectGroupOwnerHostIdByGroupId = useMemo(() => {
    if (!hasProjectGroups) {
      return EMPTY_OWNER_HOST_MAP
    }
    const byGroupId = new Map<string, ExecutionHostId | null>()
    for (const group of projectGroups) {
      const hostId = getRepoExecutionHostId(group)
      const existing = byGroupId.get(group.id)
      byGroupId.set(group.id, existing === undefined || existing === hostId ? hostId : null)
    }
    return byGroupId
  }, [hasProjectGroups, projectGroups])

  const commitRepoReorder = useCallback(
    (orderedIds: string[]) => {
      onScrollIntent()
      reorderRepos(orderedIds)
    },
    [reorderRepos, onScrollIntent]
  )
  const { orderedHostIds, nonHostRows } = useMemo(() => {
    const hosts: ExecutionHostId[] = []
    const nonHosts: Row[] = []
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      if (row.type === 'host-header') {
        hosts.push(row.hostId)
      } else {
        nonHosts.push(row)
      }
    }
    return { orderedHostIds: hosts, nonHostRows: nonHosts }
  }, [rows])
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
    () => getSidebarOrderedRepoHeaderIdsByBucket(nonHostRows),
    [nonHostRows]
  )
  const sidebarProjectGroupHeaderIdsByBucket = useMemo(
    () =>
      hasProjectGroups
        ? getSidebarOrderedProjectGroupHeaderIdsByBucket(nonHostRows, projectGroupByIdForHeaderDrag)
        : EMPTY_BUCKET_MAP,
    [hasProjectGroups, nonHostRows, projectGroupByIdForHeaderDrag]
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
    (project: Repo, projectGroupId: string | null, order: number) => {
      void moveProjectToGroup(project, projectGroupId, order)
    },
    [moveProjectToGroup]
  )
  const commitProjectGroupHeaderOrder = useCallback(
    (groupId: string, tabOrder: number) => {
      if (!Number.isFinite(tabOrder)) {
        return
      }
      onScrollIntent()
      // Why: manual order persists on the group's own host; the focused host may not hold this row.
      const ownerHostId = projectGroupOwnerHostIdByGroupId.get(groupId)
      void updateProjectGroup(groupId, { tabOrder }, { hostId: ownerHostId ?? undefined })
    },
    [projectGroupOwnerHostIdByGroupId, onScrollIntent, updateProjectGroup]
  )
  const commitRootProjectOrder = useCallback(
    (visibleKeys: readonly string[], draggedKey: string, dropIndex: number) => {
      const save = () =>
        enqueueRootProjectOrderForSidebarDrop({
          getState: useAppStore.getState,
          visibleKeys,
          draggedKey,
          dropIndex,
          onCommit: onScrollIntent
        })
      void save()
        .catch(() => false)
        .then((saved) => {
          if (!saved) {
            toast.error(
              translate(
                'auto.components.sidebar.projectOrderSaveFailed',
                'Could not save the complete project order'
              )
            )
          }
        })
    },
    [onScrollIntent]
  )
  // Drag applies only in manual order; still construct the controller inert for stable hook order.
  const repoDrag = useRepoHeaderDrag({
    orderedRepoIds: allRepoIds,
    sidebarRepoHeaderIdsByBucket,
    repoById: repoMap,
    getLiveRepos: readLiveRepos,
    usesProjectGroupOrdering: hasProjectGroups,
    onCommitRepoOrder: commitRepoReorder,
    onCommitProjectGroupOrder: commitProjectGroupOrder,
    rootProjectHeaderKeys,
    onCommitRootProjectOrder: commitRootProjectOrder,
    getScrollContainer: () => scrollRef.current
  })
  const projectGroupDrag = useProjectGroupHeaderDrag({
    sidebarProjectGroupHeaderIdsByBucket,
    projectGroupById: projectGroupByIdForHeaderDrag,
    onCommitProjectGroupTabOrder: commitProjectGroupHeaderOrder,
    rootProjectHeaderKeys,
    onCommitRootProjectOrder: commitRootProjectOrder,
    getScrollContainer: () => scrollRef.current
  })
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

  const rootProjectHeaderSectionEndByKey = useMemo(
    () =>
      hasProjectGroups
        ? getRootProjectHeaderSectionEndByKey(renderRows, firstHeaderIndex)
        : EMPTY_INDEX_MAP,
    [hasProjectGroups, renderRows, firstHeaderIndex]
  )

  return {
    rootProjectHeaderCountByOccurrenceKey,
    rootProjectHeaderSectionEndByKey,
    canReorderRepoHeaders,
    canReorderProjectGroupHeaders,
    rootProjectHeaderKeys,
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
