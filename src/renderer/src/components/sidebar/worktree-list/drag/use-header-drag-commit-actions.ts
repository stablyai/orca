import { useCallback } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import { notifyProjectGroupMoveFailed } from '@/store/project-groups/project-group-mutation-toasts'
import {
  ipcOrRuntimeTargetForHostId,
  runtimeTargetEnvironmentId
} from '@/runtime/rpc/targets/runtime-client-target'
import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { getNextRootProjectOrder } from '../../../../../../shared/sidebar-list/sections/root-project-order'
import { getProjectGroupHeaderKey } from '../../../../../../shared/sidebar-list/sections/group-keys'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import { computeAppendedProjectGroupTabOrder } from './project-group-child-drop-commit'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'
import type { ProjectGroupHeaderDragBucketKey } from './project-group-header-drop'
import { enqueueRootProjectOrderForSidebarDrop } from './root-project-order-commit'

export const readLiveRepos = (): readonly Repo[] => useAppStore.getState().repos
export const readLiveProjectGroups = (): readonly ProjectGroup[] =>
  useAppStore.getState().projectGroups

export function useHeaderDragCommitActions(args: {
  allRepoIds: readonly string[]
  repoMap: ReadonlyMap<string, Repo>
  projectGroupByIdForHeaderDrag: ReadonlyMap<string, ProjectGroup>
  projectGroupOwnerHostIdByGroupId: ReadonlyMap<string, ExecutionHostId | null>
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  onScrollIntent: () => void
  sidebarGroupChildItemIdsByGroupId: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
}) {
  const {
    allRepoIds,
    repoMap,
    projectGroupByIdForHeaderDrag,
    projectGroupOwnerHostIdByGroupId,
    sidebarProjectGroupHeaderIdsByBucket,
    onScrollIntent,
    sidebarGroupChildItemIdsByGroupId
  } = args
  const reorderRepos = useAppStore((s) => s.reorderRepos)
  const moveProjectToGroup = useAppStore((s) => s.moveProjectToGroup)
  const updateProjectGroup = useAppStore((s) => s.updateProjectGroup)

  const commitRepoReorder = useCallback(
    (orderedIds: string[]) => {
      onScrollIntent()
      reorderRepos(orderedIds)
    },
    [onScrollIntent, reorderRepos]
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
    async (
      project: Repo,
      projectGroupId: string | null,
      order: number | null,
      options?: { isPinned?: boolean }
    ): Promise<boolean> => {
      onScrollIntent()
      if (projectGroupId) {
        expandProjectGroupIfCollapsed(projectGroupId)
      }
      if (order === null) {
        const liveRepo = readLiveRepos().find((candidate) => isSameRepoRow(candidate, project))
        const needsMoveOrPin =
          !liveRepo ||
          (liveRepo.projectGroupId ?? null) !== projectGroupId ||
          (typeof options?.isPinned === 'boolean' &&
            (liveRepo.isPinned === true) !== options.isPinned)
        if (needsMoveOrPin) {
          const moved = await (typeof options?.isPinned === 'boolean'
            ? moveProjectToGroup(project, projectGroupId, 0, options)
            : moveProjectToGroup(project, projectGroupId, 0))
          if (!moved) {
            return false
          }
        }
        return useAppStore
          .getState()
          .updateRepo(
            project.id,
            { projectGroupOrder: null },
            { hostId: getRepoExecutionHostId(project) }
          )
      }
      return typeof options?.isPinned === 'boolean'
        ? moveProjectToGroup(project, projectGroupId, order, options)
        : moveProjectToGroup(project, projectGroupId, order)
    },
    [expandProjectGroupIfCollapsed, moveProjectToGroup, onScrollIntent]
  )

  const moveRepoToGroupHeader = useCallback(
    (project: Repo, groupId: string) => {
      onScrollIntent()
      expandProjectGroupIfCollapsed(groupId)
      void moveProjectToGroup(project, groupId)
    },
    [expandProjectGroupIfCollapsed, moveProjectToGroup, onScrollIntent]
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
      onScrollIntent()
      if (typeof updates.parentGroupId === 'string') {
        expandProjectGroupIfCollapsed(updates.parentGroupId)
      }
      // Why: manual order and parent group persist on the group's own host; focus may sit elsewhere.
      return updateProjectGroup(groupId, updates, { hostId: ownerHostId ?? undefined })
    },
    [
      expandProjectGroupIfCollapsed,
      onScrollIntent,
      projectGroupOwnerHostIdByGroupId,
      updateProjectGroup
    ]
  )

  const moveProjectGroupToParent = useCallback(
    (groupId: string, parentGroupId: string | null, hostId?: ExecutionHostId) => {
      onScrollIntent()
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
      onScrollIntent,
      projectGroupByIdForHeaderDrag,
      projectGroupOwnerHostIdByGroupId,
      repoMap,
      sidebarGroupChildItemIdsByGroupId,
      sidebarProjectGroupHeaderIdsByBucket,
      updateProjectGroup
    ]
  )

  const commitRootProjectOrder = useCallback(
    async (
      visibleKeys: readonly string[],
      draggedKey: string,
      dropIndex: number,
      hostId?: string
    ): Promise<boolean> => {
      const saved = await enqueueRootProjectOrderForSidebarDrop({
        getState: useAppStore.getState,
        visibleKeys,
        draggedKey,
        dropIndex,
        hostId,
        onCommit: onScrollIntent
      }).catch(() => false)
      if (!saved) {
        toast.error(
          translate(
            'auto.components.sidebar.projectOrderSaveFailed',
            'Could not save the complete project order'
          )
        )
      }
      return saved
    },
    [onScrollIntent]
  )

  const reconcileHostProjectGroups = useCallback(async (ownerHostId: ExecutionHostId) => {
    const target = ipcOrRuntimeTargetForHostId(ownerHostId)
    if (!target) {
      return
    }
    const fetchOptions = { runtimeEnvironmentId: runtimeTargetEnvironmentId(target) }
    await Promise.all([
      useAppStore.getState().fetchProjectGroups(fetchOptions),
      useAppStore.getState().fetchRepos(fetchOptions)
    ])
  }, [])

  return {
    commitRepoReorder,
    commitProjectGroupOrder,
    moveRepoToGroupHeader,
    commitProjectGroupHeaderUpdate,
    moveProjectGroupToParent,
    reconcileHostProjectGroups,
    commitRootProjectOrder
  }
}
