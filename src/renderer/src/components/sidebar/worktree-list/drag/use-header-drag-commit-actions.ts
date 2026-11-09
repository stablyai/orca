import { useCallback } from 'react'
import type React from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { notifyProjectGroupMoveFailed } from '@/store/project-groups/project-group-mutation-toasts'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { getNextRootProjectOrder } from '../../../../../../shared/root-project-order'
import { getProjectGroupHeaderKey } from '../../../../../../shared/sidebar-list/group-keys'
import { USER_SCROLL_MEASUREMENT_ADJUSTMENT_SUPPRESS_MS } from '../viewport/use-scroll-suppression'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import { computeAppendedProjectGroupTabOrder } from './project-group-child-drop-commit'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'
import type { ProjectGroupHeaderDragBucketKey } from './project-group-header-drop'
import { enqueueRootProjectOrderForSidebarDrop } from './root-project-order-commit'

export const readLiveRepos = (): readonly Repo[] => useAppStore.getState().repos

export function useHeaderDragCommitActions(args: {
  allRepoIds: readonly string[]
  repoMap: ReadonlyMap<string, Repo>
  projectGroupByIdForHeaderDrag: ReadonlyMap<string, ProjectGroup>
  projectGroupOwnerHostIdByGroupId: ReadonlyMap<string, ExecutionHostId | null>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  sidebarGroupChildItemIdsByGroupId: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  suppressMeasurementAdjustmentUntilRef: React.MutableRefObject<number>
  directScrollInputUntilRef: React.MutableRefObject<number>
}) {
  const {
    allRepoIds,
    repoMap,
    projectGroupByIdForHeaderDrag,
    projectGroupOwnerHostIdByGroupId,
    sidebarProjectGroupHeaderIdsByBucket,
    sidebarGroupChildItemIdsByGroupId,
    suppressMeasurementAdjustmentUntilRef,
    directScrollInputUntilRef
  } = args
  const reorderRepos = useAppStore((s) => s.reorderRepos)
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)

  // Suppress anchor correction after manual header moves so it cannot chase the reordered row.
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

  const expandProjectGroupIfCollapsed = useCallback((groupId: string) => {
    const key = getProjectGroupHeaderKey(groupId)
    const current = useAppStore.getState().collapsedGroups
    if (!current.has(key)) {
      return
    }
    const next = new Set(current)
    next.delete(key)
    useAppStore.getState().setCollapsedGroups(next)
  }, [])

  const commitProjectGroupOrder = useCallback(
    (project: Repo, projectGroupId: string | null, order: number): Promise<boolean> => {
      suppressScrollCorrectionForHeaderCommit()
      if (projectGroupId) {
        expandProjectGroupIfCollapsed(projectGroupId)
      }
      return moveProjectToGroup(project, projectGroupId, order)
    },
    [expandProjectGroupIfCollapsed, moveProjectToGroup, suppressScrollCorrectionForHeaderCommit]
  )

  const moveRepoToGroupHeader = useCallback(
    (project: Repo, groupId: string) => {
      suppressScrollCorrectionForHeaderCommit()
      expandProjectGroupIfCollapsed(groupId)
      void moveProjectToGroup(project, groupId)
    },
    [expandProjectGroupIfCollapsed, moveProjectToGroup, suppressScrollCorrectionForHeaderCommit]
  )

  const commitProjectGroupHeaderUpdate = useCallback(
    (groupId: string, updates: ProjectGroupHeaderUpdatePatch): Promise<boolean> => {
      if (updates.tabOrder !== undefined && !Number.isFinite(updates.tabOrder)) {
        return Promise.resolve(false)
      }
      const ownerHostId = projectGroupOwnerHostIdByGroupId.get(groupId)
      if (ownerHostId === null) {
        if (updates.parentGroupId !== undefined) {
          notifyProjectGroupMoveFailed()
        }
        return Promise.resolve(false)
      }
      suppressScrollCorrectionForHeaderCommit()
      if (typeof updates.parentGroupId === 'string') {
        expandProjectGroupIfCollapsed(updates.parentGroupId)
      }
      // Why: manual order and parent group persist on the group's own host; focus may sit elsewhere.
      return updateProjectGroup(groupId, updates, { hostId: ownerHostId ?? undefined })
    },
    [
      expandProjectGroupIfCollapsed,
      projectGroupOwnerHostIdByGroupId,
      suppressScrollCorrectionForHeaderCommit,
      updateProjectGroup
    ]
  )

  const moveProjectGroupToParent = useCallback(
    (groupId: string, parentGroupId: string | null, hostId?: ExecutionHostId) => {
      suppressScrollCorrectionForHeaderCommit()
      if (parentGroupId) {
        expandProjectGroupIfCollapsed(parentGroupId)
      }
      const ownerHostId = hostId ?? projectGroupOwnerHostIdByGroupId.get(groupId)
      if (ownerHostId === null) {
        notifyProjectGroupMoveFailed()
        return
      }
      const catalogHostId = ownerHostId ? getCatalogHostIdForExecutionHost(ownerHostId) : null
      const liveGroups = useAppStore.getState().projectGroups
      const hostProjectGroups = catalogHostId
        ? liveGroups.filter(
            (candidate) =>
              getCatalogHostIdForExecutionHost(getRepoExecutionHostId(candidate)) === catalogHostId
          )
        : [...projectGroupByIdForHeaderDrag.values()]
      const effectiveGroupById =
        catalogHostId && hostProjectGroups.length > 0
          ? new Map(hostProjectGroups.map((candidate) => [candidate.id, candidate]))
          : projectGroupByIdForHeaderDrag
      const hostRepos = catalogHostId
        ? readLiveRepos().filter(
            (repo) =>
              getCatalogHostIdForExecutionHost(getRepoExecutionHostId(repo)) === catalogHostId
          )
        : readLiveRepos()
      const tabOrder = computeAppendedProjectGroupTabOrder({
        groupId,
        parentGroupId,
        ownerHostId,
        sidebarProjectGroupHeaderIdsByBucket,
        sidebarGroupChildItemIdsByGroupId,
        projectGroupById: effectiveGroupById,
        repoById: repoMap,
        liveRepos: hostRepos,
        orderedRepoIds: allRepoIds
      })
      const group = effectiveGroupById.get(groupId)
      const nextRootOrder =
        parentGroupId === null ? getNextRootProjectOrder(hostRepos, hostProjectGroups) : undefined
      void updateProjectGroup(
        groupId,
        {
          parentGroupId,
          tabOrder,
          ...(parentGroupId !== null && group?.rootProjectOrder !== undefined
            ? { rootProjectOrder: null }
            : nextRootOrder !== undefined
              ? { rootProjectOrder: nextRootOrder }
              : {})
        },
        { hostId: ownerHostId ?? undefined }
      )
    },
    [
      allRepoIds,
      expandProjectGroupIfCollapsed,
      projectGroupByIdForHeaderDrag,
      projectGroupOwnerHostIdByGroupId,
      repoMap,
      sidebarGroupChildItemIdsByGroupId,
      sidebarProjectGroupHeaderIdsByBucket,
      suppressScrollCorrectionForHeaderCommit,
      updateProjectGroup
    ]
  )

  const commitRootProjectOrder = useCallback(
    (visibleKeys: readonly string[], draggedKey: string, dropIndex: number, hostId?: string) => {
      const save = () =>
        enqueueRootProjectOrderForSidebarDrop({
          getState: useAppStore.getState,
          visibleKeys,
          draggedKey,
          dropIndex,
          hostId,
          onCommit: suppressScrollCorrectionForHeaderCommit
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
    [suppressScrollCorrectionForHeaderCommit]
  )

  return {
    commitRepoReorder,
    commitProjectGroupOrder,
    moveRepoToGroupHeader,
    commitProjectGroupHeaderUpdate,
    moveProjectGroupToParent,
    commitRootProjectOrder
  }
}
