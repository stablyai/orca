import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  getProjectGroupHeaderDragBucketKey,
  getProjectGroupTabOrderUpdatesForSidebarDrop,
  type ProjectGroupHeaderDragBucketKey
} from './project-group-header-drop'
import {
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
  collectTargetProjectGroupSiblingIds,
  filterProjectGroupIdsByExactOwnerHost
} from './group-header-hit-geometry'
import {
  abortGroupDropWithRollback,
  executeProjectGroupDropUpdates,
  invokeBoolCallback
} from './project-group-header-drag-rollback'
import {
  maybeRespacePromotedRootOrder,
  resolveRootPromotionPlacement
} from './project-group-root-promotion-order'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export { collectTargetProjectGroupSiblingIds }

export type ProjectGroupDropMutation = {
  groupId: string
  updates: ProjectGroupHeaderUpdatePatch
}

export function getProjectGroupMutationsForDrop(args: {
  draggedGroup: ProjectGroup
  sourceBucketKey: ProjectGroupHeaderDragBucketKey
  dropTarget: ProjectGroupHeaderDropTarget
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repos?: readonly Repo[]
  rootProjectHeaderKeys?: readonly string[]
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

  if (args.dropTarget.kind === 'slot' && args.dropTarget.targetBucketKey === args.sourceBucketKey) {
    const sameHostHeaderIds = filterProjectGroupIdsByExactOwnerHost(
      args.sidebarProjectGroupHeaderIdsByBucket.get(args.sourceBucketKey) ?? [],
      draggedHostId,
      args.projectGroupById
    )
    return getProjectGroupTabOrderUpdatesForSidebarDrop({
      sidebarProjectGroupHeaderIds: sameHostHeaderIds,
      draggedGroupId: args.draggedGroup.id,
      sidebarDropIndex: args.dropTarget.dropIndex,
      projectGroupById: args.projectGroupById
    }).map((update) => ({
      groupId: update.groupId,
      updates: { tabOrder: update.tabOrder }
    }))
  }

  const targetParentGroupId =
    args.dropTarget.kind === 'group-header'
      ? args.dropTarget.groupId
      : parseParentGroupIdFromBucketKey(args.dropTarget.targetBucketKey)
  const currentParentGroupId = parseParentGroupIdFromBucketKey(liveBucketKey)
  if (args.dropTarget.kind === 'group-header' && targetParentGroupId === currentParentGroupId) {
    return []
  }
  if (targetParentGroupId !== null) {
    const reparentableIds = getReparentableTargetGroupIdsForGroup(args.draggedGroup, [
      ...args.projectGroupById.values()
    ])
    if (!reparentableIds.has(targetParentGroupId)) {
      return []
    }
  }

  const targetBucketKey: ProjectGroupHeaderDragBucketKey = targetParentGroupId
    ? `parent:${targetParentGroupId}`
    : 'root'
  const existingSiblingIds = collectTargetProjectGroupSiblingIds({
    draggedGroupId: args.draggedGroup.id,
    targetParentGroupId,
    ownerHostId: draggedHostId,
    seededSiblingIds: args.sidebarProjectGroupHeaderIdsByBucket.get(targetBucketKey) ?? [],
    projectGroupById: args.projectGroupById
  })
  const rootPlacement =
    targetParentGroupId === null
      ? resolveRootPromotionPlacement({
          draggedGroup: args.draggedGroup,
          existingSiblingIds,
          dropTarget: args.dropTarget,
          projectGroupById: args.projectGroupById,
          repos: args.repos,
          rootProjectHeaderKeys: args.rootProjectHeaderKeys,
          nextRootProjectOrder: args.nextRootProjectOrder
        })
      : null
  const visibleSiblingIds = filterProjectGroupIdsByExactOwnerHost(
    args.sidebarProjectGroupHeaderIdsByBucket.get(targetBucketKey) ?? [],
    draggedHostId,
    args.projectGroupById
  ).filter((groupId) => groupId !== args.draggedGroup.id)
  const anchorGroupId =
    args.dropTarget.kind === 'slot' && args.dropTarget.dropIndex >= 0
      ? visibleSiblingIds[args.dropTarget.dropIndex]
      : undefined
  const anchorIndex = anchorGroupId !== undefined ? existingSiblingIds.indexOf(anchorGroupId) : -1
  const insertIndex = rootPlacement
    ? rootPlacement.groupInsertIndex
    : args.dropTarget.kind === 'group-header' || anchorIndex === -1
      ? existingSiblingIds.length
      : anchorIndex
  const orderedIds = existingSiblingIds.slice()
  orderedIds.splice(insertIndex, 0, args.draggedGroup.id)
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
      mutations.push({
        groupId,
        updates: { tabOrder: index }
      })
    }
  }
  return mutations
}

export async function commitProjectGroupHeaderDragDrop(
  args: RootProjectHeaderDrag & {
    session: Pick<ProjectGroupHeaderDragSession, 'groupId' | 'bucketKey' | 'rootProjectHeaderKeys'>
    dropTarget: ProjectGroupHeaderDropTarget
    projectGroupById: ReadonlyMap<string, ProjectGroup>
    getLiveProjectGroups?: () => readonly ProjectGroup[]
    repos?: readonly Repo[]
    sidebarProjectGroupHeaderIdsByBucket: ReadonlyMap<
      ProjectGroupHeaderDragBucketKey,
      readonly string[]
    >
    nextRootProjectOrder?: number
    onCommitProjectGroupUpdate: (
      groupId: string,
      updates: ProjectGroupHeaderUpdatePatch
    ) => Promise<boolean> | boolean | void
    onReconcileHostProjectGroups?: (ownerHostId: ExecutionHostId) => Promise<void> | void
    onDropFailed?: () => void
  }
): Promise<boolean> {
  if (
    args.session.bucketKey === 'root' &&
    args.dropTarget.kind === 'slot' &&
    args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
    args.session.rootProjectHeaderKeys
  ) {
    const commitRootOrder = args.onCommitRootProjectOrder
    const rootKeys = args.session.rootProjectHeaderKeys
    const dropIndex = args.dropTarget.dropIndex
    if (!commitRootOrder) {
      return false
    }
    return invokeBoolCallback(() =>
      commitRootOrder(rootKeys, `group:${args.session.groupId}`, dropIndex)
    )
  }
  const draggedGroup = args.projectGroupById.get(args.session.groupId)
  if (!draggedGroup) {
    return false
  }
  const mutations = getProjectGroupMutationsForDrop({
    draggedGroup,
    sourceBucketKey: args.session.bucketKey,
    dropTarget: args.dropTarget,
    projectGroupById: args.projectGroupById,
    repos: args.repos,
    rootProjectHeaderKeys: args.session.rootProjectHeaderKeys,
    sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
    nextRootProjectOrder: args.nextRootProjectOrder
  })
  const reparentMutation = mutations.find(
    (mutation) => mutation.updates.parentGroupId !== undefined
  )
  const expectedParentGroupId = reparentMutation
    ? (reparentMutation.updates.parentGroupId ?? null)
    : args.dropTarget.kind === 'group-header'
      ? args.dropTarget.groupId
      : parseParentGroupIdFromBucketKey(args.dropTarget.targetBucketKey)
  const draggedOwnerHostId = getRepoExecutionHostId(draggedGroup)
  const commitResult = await executeProjectGroupDropUpdates({
    mutations,
    reparentMutation,
    expectedParentGroupId,
    ownerHostId: draggedOwnerHostId,
    projectGroupById: args.projectGroupById,
    getLiveProjectGroups: args.getLiveProjectGroups,
    onCommitProjectGroupUpdate: args.onCommitProjectGroupUpdate,
    onReconcileHostProjectGroups: args.onReconcileHostProjectGroups,
    onDropFailed: args.onDropFailed
  })
  if (!commitResult.ok) {
    return false
  }
  if (reparentMutation?.updates.parentGroupId === null && args.onCommitRootProjectOrder) {
    const respaced = await maybeRespacePromotedRootOrder({
      draggedGroup,
      dropTarget: args.dropTarget,
      projectGroupById: args.projectGroupById,
      repos: args.repos,
      rootProjectHeaderKeys: args.session.rootProjectHeaderKeys,
      sidebarProjectGroupHeaderIdsByBucket: args.sidebarProjectGroupHeaderIdsByBucket,
      nextRootProjectOrder: args.nextRootProjectOrder,
      onCommitRootProjectOrder: args.onCommitRootProjectOrder
    })
    if (!respaced) {
      return abortGroupDropWithRollback({
        appliedRollbacks: commitResult.appliedRollbacks,
        ownerHostId: draggedOwnerHostId,
        getLiveProjectGroups: args.getLiveProjectGroups,
        fallbackProjectGroupById: args.projectGroupById,
        onCommitProjectGroupUpdate: args.onCommitProjectGroupUpdate,
        onReconcileHostProjectGroups: args.onReconcileHostProjectGroups,
        onDropFailed: args.onDropFailed
      })
    }
  }
  return true
}
