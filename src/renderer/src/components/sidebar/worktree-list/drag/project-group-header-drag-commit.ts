import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import type { Repo } from '../../../../../../shared/repo-types'
import {
  compareCodePoints,
  compareSidebarText
} from '../../../../../../shared/sidebar-list/text-order'
import {
  getProjectGroupHeaderDragBucketKey,
  getProjectGroupTabOrderUpdatesForSidebarDrop,
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
import { isProjectGroupStillInExpectedParent } from './group-header-hit-geometry'
import {
  buildSyntheticRootRespaceDrop,
  resolveRootPromotionPlacement
} from './project-group-root-promotion-order'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export type ProjectGroupDropMutation = {
  groupId: string
  updates: ProjectGroupHeaderUpdatePatch
}

export function collectTargetProjectGroupSiblingIds(args: {
  draggedGroupId: string
  targetParentGroupId: string | null
  ownerHostId: ExecutionHostId | null | undefined
  seededSiblingIds: readonly string[]
  projectGroupById: ReadonlyMap<string, ProjectGroup>
}): string[] {
  const result = filterProjectGroupIdsByCatalogHost(
    args.seededSiblingIds,
    args.ownerHostId,
    args.projectGroupById
  ).filter((groupId) => groupId !== args.draggedGroupId)
  const seen = new Set(result)
  const hiddenSiblings = filterProjectGroupIdsByCatalogHost(
    [...args.projectGroupById.values()]
      .filter((candidate) => {
        if (candidate.id === args.draggedGroupId || seen.has(candidate.id)) {
          return false
        }
        return args.targetParentGroupId !== null
          ? candidate.parentGroupId === args.targetParentGroupId
          : !candidate.parentGroupId || !args.projectGroupById.has(candidate.parentGroupId)
      })
      .sort(
        (left, right) =>
          left.tabOrder - right.tabOrder ||
          compareSidebarText(left.name, right.name) ||
          compareCodePoints(left.id, right.id)
      )
      .map((candidate) => candidate.id),
    args.ownerHostId,
    args.projectGroupById
  )
  return [...result, ...hiddenSiblings]
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
    const sameHostHeaderIds = filterProjectGroupIdsByCatalogHost(
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
  const insertIndex = rootPlacement
    ? rootPlacement.groupInsertIndex
    : args.dropTarget.kind === 'group-header'
      ? existingSiblingIds.length
      : Math.max(0, Math.min(existingSiblingIds.length, args.dropTarget.dropIndex))
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
      args.dropTarget.dropIndex
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
    if (
      mutation === reparentMutation ||
      !isProjectGroupStillInExpectedParent({
        groupId: mutation.groupId,
        expectedParentGroupId,
        ownerHostId: draggedOwnerHostId,
        liveProjectGroups: args.getLiveProjectGroups?.(),
        fallbackProjectGroupById: args.projectGroupById
      })
    ) {
      continue
    }
    await args.onCommitProjectGroupUpdate(mutation.groupId, mutation.updates)
  }
  if (
    reparentMutation?.updates.parentGroupId === null &&
    args.dropTarget.kind === 'slot' &&
    (args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_GROUP_BUCKET_KEY ||
      args.dropTarget.targetBucketKey === 'root') &&
    args.onCommitRootProjectOrder
  ) {
    const existingSiblingIds = filterProjectGroupIdsByCatalogHost(
      args.sidebarProjectGroupHeaderIdsByBucket.get('root') ?? [],
      draggedOwnerHostId,
      args.projectGroupById
    ).filter((groupId) => groupId !== draggedGroup.id)
    const placement = resolveRootPromotionPlacement({
      draggedGroup,
      existingSiblingIds,
      dropTarget: args.dropTarget,
      projectGroupById: args.projectGroupById,
      repos: args.repos,
      rootProjectHeaderKeys: args.session.rootProjectHeaderKeys,
      nextRootProjectOrder: args.nextRootProjectOrder
    })
    const baseKeys =
      args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_GROUP_BUCKET_KEY &&
      args.session.rootProjectHeaderKeys
        ? args.session.rootProjectHeaderKeys
        : placement.respaceKeys
    if (
      placement.needsInterleavedRespace &&
      placement.interleavedDropIndex !== undefined &&
      baseKeys
    ) {
      const draggedKey = `group:${args.session.groupId}`
      const respaceDrop = buildSyntheticRootRespaceDrop(
        baseKeys,
        draggedKey,
        placement.interleavedDropIndex
      )
      if (respaceDrop) {
        args.onCommitRootProjectOrder(respaceDrop.visibleKeys, draggedKey, respaceDrop.dropIndex)
      }
    }
  }
}
