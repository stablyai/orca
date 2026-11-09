import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { computeProjectGroupChildDropMutations } from './project-group-child-drop-commit'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'
import {
  getProjectGroupHeaderDragBucketKey,
  mapSidebarProjectGroupDropIndexToSiblingInsertIndex,
  type ProjectGroupHeaderDragBucketKey
} from './project-group-header-drop'
import {
  filterProjectGroupIdsByCatalogHost,
  getReparentableTargetGroupIdsForGroup,
  parseParentGroupIdFromBucketKey,
  type ProjectGroupHeaderDropTarget
} from './project-group-header-reparent-drop'
import {
  ROOT_INTERLEAVED_GROUP_BUCKET_KEY,
  type ProjectGroupHeaderDragSession,
  type ProjectGroupHeaderUpdatePatch
} from './project-group-header-drag-contract'
import {
  maybeRespacePromotedRootOrder,
  resolveRootPromotionPlacement
} from './project-group-root-promotion-order'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export type ProjectGroupDropMutation =
  | { groupId: string; updates: ProjectGroupHeaderUpdatePatch }
  | { kind: 'repo'; repo: Repo; projectGroupId: string; order: number }

export function getProjectGroupMutationsForDrop(args: {
  draggedGroup: ProjectGroup
  sourceBucketKey: ProjectGroupHeaderDragBucketKey
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repos?: readonly Repo[]
  rootProjectHeaderKeys?: readonly string[]
  allowMixedProjectReorder?: boolean
  sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
  repoById?: ReadonlyMap<string, Repo>
  pinnedRepoHeaderIds?: ReadonlySet<string>
  orderedRepoIds?: readonly string[]
  sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
    ProjectGroupHeaderDragBucketKey,
    readonly string[]
  >
  nextRootProjectOrder?: number
}): ProjectGroupDropMutation[] {
  const liveBucketKey = getProjectGroupHeaderDragBucketKey(args.draggedGroup, args.projectGroupById)
  if (liveBucketKey !== args.sourceBucketKey) {
    return []
  }
  const draggedHostId = getRepoExecutionHostId(args.draggedGroup)
  const targetParentGroupId =
    args.dropTarget.kind === 'group-header'
      ? args.dropTarget.groupId
      : parseParentGroupIdFromBucketKey(args.dropTarget.targetBucketKey)
  const currentParentGroupId = parseParentGroupIdFromBucketKey(liveBucketKey)

  if (args.dropTarget.kind === 'group-header' && targetParentGroupId === currentParentGroupId) {
    return []
  }
  if (targetParentGroupId !== null && targetParentGroupId !== currentParentGroupId) {
    const reparentableIds = getReparentableTargetGroupIdsForGroup(args.draggedGroup, [
      ...args.projectGroupById.values()
    ])
    if (!reparentableIds.has(targetParentGroupId)) {
      return []
    }
  }

  if (
    targetParentGroupId !== null &&
    args.allowMixedProjectReorder &&
    args.sidebarGroupChildItemIdsByGroupId
  ) {
    const isCrossBucket =
      args.dropTarget.kind === 'group-header' ||
      args.dropTarget.targetBucketKey !== args.sourceBucketKey
    const childMutations = computeProjectGroupChildDropMutations({
      parentGroupId: targetParentGroupId,
      draggedItem: { kind: 'group', group: args.draggedGroup },
      isCrossBucket,
      dropIndex: args.dropTarget.kind === 'group-header' ? 'append' : args.dropTarget.dropIndex,
      dragHostId: draggedHostId,
      allChildItemIds: args.sidebarGroupChildItemIdsByGroupId.get(targetParentGroupId) ?? [],
      projectGroupById: args.projectGroupById,
      liveRepos: args.repos,
      repoById: args.repoById,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      orderedRepoIds: args.orderedRepoIds
    })
    return childMutations.map((mutation) =>
      mutation.kind === 'group'
        ? { groupId: mutation.groupId, updates: mutation.updates }
        : mutation
    )
  }

  const partitionGroupIdsByPin = (ids: readonly string[]) => ({
    pinned: ids.filter((id) => args.projectGroupById.get(id)?.isPinned === true),
    unpinned: ids.filter((id) => args.projectGroupById.get(id)?.isPinned !== true)
  })

  if (args.dropTarget.kind === 'slot' && args.dropTarget.targetBucketKey === args.sourceBucketKey) {
    const sameHostHeaderIds = filterProjectGroupIdsByCatalogHost(
      args.sidebarProjectGroupHeaderIdsByBucket.get(args.sourceBucketKey) ?? [],
      draggedHostId,
      args.projectGroupById
    )
    const draggedPinned = args.draggedGroup.isPinned === true
    const { pinned: pinnedIds, unpinned: unpinnedIds } = partitionGroupIdsByPin(sameHostHeaderIds)
    const tierIds = draggedPinned ? pinnedIds : unpinnedIds
    const sourceIndex = tierIds.indexOf(args.draggedGroup.id)
    if (sourceIndex === -1) {
      return []
    }
    const tierSiblingIds = tierIds.filter((id) => id !== args.draggedGroup.id)
    const siblingDropIndex = mapSidebarProjectGroupDropIndexToSiblingInsertIndex({
      sidebarDropIndex: args.dropTarget.dropIndex,
      sourceIndex,
      siblingCount: tierSiblingIds.length
    })
    if (siblingDropIndex === Math.min(sourceIndex, tierSiblingIds.length)) {
      return []
    }
    const reorderedTierIds = tierSiblingIds.slice()
    reorderedTierIds.splice(siblingDropIndex, 0, args.draggedGroup.id)
    const orderedIds = draggedPinned
      ? [...reorderedTierIds, ...unpinnedIds]
      : [...pinnedIds, ...reorderedTierIds]

    const mutations: ProjectGroupDropMutation[] = []
    for (const [index, groupId] of orderedIds.entries()) {
      const group = args.projectGroupById.get(groupId)
      if (group && group.tabOrder !== index) {
        mutations.push({ groupId, updates: { tabOrder: index } })
      }
    }
    return mutations
  }

  const targetBucketKey: ProjectGroupHeaderDragBucketKey = targetParentGroupId
    ? `parent:${targetParentGroupId}`
    : 'root'
  const existingSiblingIds = filterProjectGroupIdsByCatalogHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get(targetBucketKey) ?? [],
    draggedHostId,
    args.projectGroupById
  ).filter((groupId) => groupId !== args.draggedGroup.id)
  const { pinned: pinnedSiblingIds, unpinned: unpinnedSiblingIds } =
    partitionGroupIdsByPin(existingSiblingIds)
  const rootPlacement =
    targetParentGroupId === null
      ? resolveRootPromotionPlacement({
          draggedGroup: args.draggedGroup,
          existingUnpinnedSiblingIds: unpinnedSiblingIds,
          dropTarget: args.dropTarget,
          projectGroupById: args.projectGroupById,
          repos: args.repos,
          pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
          rootProjectHeaderKeys: args.rootProjectHeaderKeys,
          nextRootProjectOrder: args.nextRootProjectOrder
        })
      : null
  const insertIndex = rootPlacement
    ? rootPlacement.groupInsertIndex
    : args.dropTarget.kind === 'group-header'
      ? unpinnedSiblingIds.length
      : Math.max(0, Math.min(unpinnedSiblingIds.length, args.dropTarget.dropIndex))
  const nextUnpinnedIds = unpinnedSiblingIds.slice()
  nextUnpinnedIds.splice(insertIndex, 0, args.draggedGroup.id)
  const orderedIds = [...pinnedSiblingIds, ...nextUnpinnedIds]
  const rootOrderPatch = rootPlacement
    ? rootPlacement.rootOrderPatch
    : args.draggedGroup.rootProjectOrder !== undefined
      ? { rootProjectOrder: null }
      : {}

  const mutations: ProjectGroupDropMutation[] = []
  for (const [index, groupId] of orderedIds.entries()) {
    if (groupId === args.draggedGroup.id) {
      mutations.push({
        groupId,
        updates: { parentGroupId: targetParentGroupId, tabOrder: index, ...rootOrderPatch }
      })
      continue
    }
    const sibling = args.projectGroupById.get(groupId)
    if (sibling && sibling.tabOrder !== index) {
      mutations.push({ groupId, updates: { tabOrder: index } })
    }
  }
  return mutations
}

export async function commitProjectGroupHeaderDragDrop(
  args: RootProjectHeaderDrag & {
    session: Pick<
      ProjectGroupHeaderDragSession,
      'groupId' | 'bucketKey' | 'rootProjectHeaderKeys' | 'rootProjectHeaderHostId'
    >
    dropTarget: ProjectGroupHeaderDropTarget
    projectGroupById: ReadonlyMap<string, ProjectGroup>
    repos?: readonly Repo[]
    allowMixedProjectReorder?: boolean
    sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
    repoById?: ReadonlyMap<string, Repo>
    pinnedRepoHeaderIds?: ReadonlySet<string>
    orderedRepoIds?: readonly string[]
    sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
      ProjectGroupHeaderDragBucketKey,
      readonly string[]
    >
    nextRootProjectOrder?: number
    onCommitProjectGroupUpdate: (
      groupId: string,
      updates: ProjectGroupHeaderUpdatePatch
    ) => Promise<boolean> | boolean | void
    onCommitProjectGroupOrder?: (
      project: Repo,
      projectGroupId: string | null,
      order: number
    ) => Promise<boolean> | boolean | void
  }
): Promise<void> {
  if (
    args.session.bucketKey === 'root' &&
    args.dropTarget.kind === 'slot' &&
    args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
    args.session.rootProjectHeaderKeys
  ) {
    args.onCommitRootProjectOrder?.(
      args.session.rootProjectHeaderKeys,
      `group:${args.session.groupId}`,
      args.dropTarget.dropIndex,
      args.session.rootProjectHeaderHostId
    )
    return
  }
  const draggedGroup = args.projectGroupById.get(args.session.groupId)
  if (!draggedGroup) {
    return
  }
  const mutations = getProjectGroupMutationsForDrop({
    draggedGroup,
    sourceBucketKey: args.session.bucketKey,
    dropTarget: args.dropTarget,
    projectGroupById: args.projectGroupById,
    repos: args.repos,
    rootProjectHeaderKeys: args.session.rootProjectHeaderKeys,
    allowMixedProjectReorder: args.allowMixedProjectReorder,
    sidebarGroupChildItemIdsByGroupId: args.sidebarGroupChildItemIdsByGroupId,
    repoById: args.repoById,
    pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
    orderedRepoIds: args.orderedRepoIds,
    sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
    nextRootProjectOrder: args.nextRootProjectOrder
  })
  const reparentMutation = mutations.find(
    (mutation): mutation is { groupId: string; updates: ProjectGroupHeaderUpdatePatch } =>
      !('kind' in mutation) && mutation.updates.parentGroupId !== undefined
  )
  if (reparentMutation) {
    const accepted = await args.onCommitProjectGroupUpdate(
      reparentMutation.groupId,
      reparentMutation.updates
    )
    if (accepted === false) {
      return
    }
  }
  for (const mutation of mutations) {
    if (mutation === reparentMutation) {
      continue
    }
    if ('kind' in mutation) {
      const orderAccepted = await args.onCommitProjectGroupOrder?.(
        mutation.repo,
        mutation.projectGroupId,
        mutation.order
      )
      if (orderAccepted === false) {
        return
      }
      continue
    }
    const groupAccepted = await args.onCommitProjectGroupUpdate(mutation.groupId, mutation.updates)
    if (groupAccepted === false) {
      return
    }
  }
  if (reparentMutation?.updates.parentGroupId === null) {
    maybeRespacePromotedRootOrder({
      draggedGroup,
      dropTarget: args.dropTarget,
      projectGroupById: args.projectGroupById,
      repos: args.repos,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      rootProjectHeaderKeys: args.session.rootProjectHeaderKeys,
      rootProjectHeaderHostId: args.session.rootProjectHeaderHostId,
      sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
      nextRootProjectOrder: args.nextRootProjectOrder,
      onCommitRootProjectOrder: args.onCommitRootProjectOrder
    })
  }
}
