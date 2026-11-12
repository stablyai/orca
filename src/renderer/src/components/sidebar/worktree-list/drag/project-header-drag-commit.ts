import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import { getNextRootProjectOrder } from '../../../../../../shared/root-project-order'
import type { Repo } from '../../../../../../shared/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import { getCatalogHostIdForExecutionHost } from './group-header-hit-geometry'
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import {
  filterRepoHeaderIdsByCatalogHost,
  findChildRepoForCatalogHost
} from './project-group-child-catalog'
import { computeProjectGroupChildDropMutations } from './project-group-child-drop-commit'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'
import {
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  type ProjectHeaderDragSession
} from './project-header-drag-contract'
import {
  applyAllRepoInsertAt,
  getProjectHeaderDragBucketKey,
  getProjectGroupOrderForSidebarDrop,
  mapSidebarProjectHeaderDropIndexToSiblingInsertIndex,
  mapSidebarRepoDropIndexToAllRepoInsertAt,
  type ProjectHeaderDragBucketKey
} from './project-header-drop'
import {
  parseGroupIdFromBucketKey,
  type ProjectHeaderDropTarget
} from './project-header-group-drop'
import { resolveUngroupedRepoInterleavedRootPlacement } from './project-header-root-ungroup-order'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export async function commitProjectHeaderDragDrop(
  args: RootProjectHeaderDrag & {
    session: Pick<
      ProjectHeaderDragSession,
      | 'repo'
      | 'groupRepo'
      | 'bucketKey'
      | 'sidebarRepoHeaderIds'
      | 'rootProjectHeaderKeys'
      | 'rootProjectHeaderHostId'
    >
    dropTarget: ProjectHeaderDropTarget
    sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
    sidebarGroupChildItemIdsByGroupId?: ReadonlyMap<string, readonly ProjectGroupChildItemId[]>
    projectGroupById?: ReadonlyMap<string, ProjectGroup>
    pinnedRepoHeaderIds?: ReadonlySet<string>
    orderedRepoIds: readonly string[]
    repoById: ReadonlyMap<string, Repo>
    liveRepos: readonly Repo[]
    projectGroups?: readonly ProjectGroup[]
    usesProjectGroupOrdering: boolean
    onCommitRepoOrder: (orderedIds: string[]) => void
    onCommitProjectGroupOrder: (
      project: Repo,
      projectGroupId: string | null,
      order: number
    ) => Promise<boolean> | boolean | void
    onCommitProjectGroupUpdate?: (
      groupId: string,
      updates: ProjectGroupHeaderUpdatePatch
    ) => Promise<boolean> | boolean | void
    onMoveToGroupHeader: (project: Repo, groupId: string) => void
  }
): Promise<void> {
  const draggedOrderRepo = args.liveRepos.find((repo) => isSameRepoRow(repo, args.session.repo))
  const groupTargetCandidate =
    args.session.groupRepo === undefined ? args.session.repo : args.session.groupRepo
  const draggedGroupRepo = groupTargetCandidate
    ? args.liveRepos.find((repo) => isSameRepoRow(repo, groupTargetCandidate))
    : undefined

  if (args.dropTarget.kind === 'group-header') {
    if (
      !draggedGroupRepo ||
      getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey
    ) {
      return
    }
    if ((draggedGroupRepo.projectGroupId ?? null) !== args.dropTarget.groupId) {
      args.onMoveToGroupHeader(draggedGroupRepo, args.dropTarget.groupId)
    }
    return
  }

  if (
    args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_PROJECT_BUCKET_KEY &&
    args.session.rootProjectHeaderKeys
  ) {
    if (args.session.bucketKey === 'ungrouped') {
      args.onCommitRootProjectOrder?.(
        args.session.rootProjectHeaderKeys,
        `repo:${args.session.repo.id}`,
        args.dropTarget.dropIndex,
        args.session.rootProjectHeaderHostId
      )
      return
    }
    if (
      !draggedGroupRepo ||
      getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey
    ) {
      return
    }
    const placement = resolveUngroupedRepoInterleavedRootPlacement({
      draggedRepo: draggedGroupRepo,
      dropIndex: args.dropTarget.dropIndex,
      rootProjectHeaderKeys: args.session.rootProjectHeaderKeys,
      projectGroupById: args.projectGroupById,
      projectGroups: args.projectGroups,
      liveRepos: args.liveRepos,
      repoById: args.repoById,
      orderedRepoIds: args.orderedRepoIds
    })
    const accepted = await args.onCommitProjectGroupOrder(draggedGroupRepo, null, placement.order)
    if (accepted !== false && placement.needsInterleavedRespace) {
      args.onCommitRootProjectOrder?.(
        placement.interleavedKeysWithRepo,
        `repo:${draggedGroupRepo.id}`,
        placement.clampedDropIndex,
        args.session.rootProjectHeaderHostId
      )
    }
    return
  }

  const targetGroupId = parseGroupIdFromBucketKey(args.dropTarget.targetBucketKey)
  if (
    targetGroupId !== null &&
    draggedGroupRepo &&
    args.sidebarGroupChildItemIdsByGroupId &&
    args.projectGroupById
  ) {
    if (getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey) {
      return
    }
    const isCrossBucket = args.dropTarget.targetBucketKey !== args.session.bucketKey
    const mutations = computeProjectGroupChildDropMutations({
      parentGroupId: targetGroupId,
      draggedItem: { kind: 'repo', repo: draggedGroupRepo },
      isCrossBucket,
      dropIndex: args.dropTarget.dropIndex,
      dragHostId: getRepoExecutionHostId(draggedGroupRepo),
      allChildItemIds: args.sidebarGroupChildItemIdsByGroupId.get(targetGroupId) ?? [],
      projectGroupById: args.projectGroupById,
      repoById: args.repoById,
      liveRepos: args.liveRepos,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      orderedRepoIds: args.orderedRepoIds
    })
    const primaryMutation = isCrossBucket
      ? mutations.find((m) => m.kind === 'repo' && m.repo === draggedGroupRepo)
      : undefined
    const applyMutation = async (mutation: (typeof mutations)[number]): Promise<boolean> => {
      const accepted =
        mutation.kind === 'repo'
          ? await args.onCommitProjectGroupOrder(
              mutation.repo,
              mutation.projectGroupId,
              mutation.order
            )
          : await args.onCommitProjectGroupUpdate?.(mutation.groupId, mutation.updates)
      return accepted !== false
    }
    if (primaryMutation && !(await applyMutation(primaryMutation))) {
      return
    }
    for (const mutation of mutations) {
      if (mutation === primaryMutation) {
        continue
      }
      if (!(await applyMutation(mutation))) {
        return
      }
    }
    return
  }

  if (args.dropTarget.targetBucketKey !== args.session.bucketKey) {
    if (
      !draggedGroupRepo ||
      getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey
    ) {
      return
    }
    const dragHostId = getRepoExecutionHostId(draggedGroupRepo)
    const catalogHostId = getCatalogHostIdForExecutionHost(dragHostId)
    const targetHeaderIds = filterRepoHeaderIdsByCatalogHost(
      args.sidebarRepoHeaderIdsByBucket.get(args.dropTarget.targetBucketKey) ?? [],
      dragHostId,
      args.liveRepos,
      args.repoById
    )
    const siblings = targetHeaderIds
      .filter(
        (repoId) =>
          repoId !== draggedGroupRepo.id &&
          !isRepoHeaderIdPinned(repoId, args.pinnedRepoHeaderIds, args.repoById)
      )
      .map((repoId) =>
        findChildRepoForCatalogHost(repoId, dragHostId, args.repoById, args.liveRepos)
      )
      .filter((repo): repo is Repo => repo !== undefined)
    const clampedDropIndex = Math.max(0, Math.min(siblings.length, args.dropTarget.dropIndex))
    const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds)
    const matchesHost = (hostId: ReturnType<typeof getRepoExecutionHostId>): boolean =>
      !catalogHostId || getCatalogHostIdForExecutionHost(hostId) === catalogHostId
    const order =
      targetGroupId === null && siblings.length === 0 && args.projectGroups
        ? (getNextRootProjectOrder(
            args.liveRepos.filter((repo) => matchesHost(getRepoExecutionHostId(repo))),
            args.projectGroups.filter((group) => matchesHost(getRepoExecutionHostId(group)))
          ) ?? 0)
        : getProjectGroupOrderForSidebarDrop({
            siblings,
            dropIndex: clampedDropIndex,
            repoOrderRankById
          })
    await args.onCommitProjectGroupOrder(draggedGroupRepo, targetGroupId, order)
    return
  }

  // Why: a group change mid-drag (another window or client) moved the row out of this bucket.
  const bucketLiveRepo = draggedGroupRepo ?? draggedOrderRepo
  if (
    !draggedOrderRepo ||
    !bucketLiveRepo ||
    getProjectHeaderDragBucketKey(bucketLiveRepo) !== args.session.bucketKey
  ) {
    return
  }

  const sidebarDropIndex = args.dropTarget.dropIndex
  const draggedPinned =
    isRepoHeaderIdPinned(draggedOrderRepo.id, args.pinnedRepoHeaderIds, args.repoById) ||
    bucketLiveRepo.isPinned === true
  const sidebarRepoHeaderIds = args.session.sidebarRepoHeaderIds.filter(
    (repoId) =>
      isRepoHeaderIdPinned(repoId, args.pinnedRepoHeaderIds, args.repoById) === draggedPinned
  )
  const sourceIndex = sidebarRepoHeaderIds.indexOf(draggedOrderRepo.id)
  // Both slots beside the dragged header are no-ops; do not compact paired-host occurrences.
  if (
    sourceIndex === -1 ||
    sidebarDropIndex === sourceIndex ||
    sidebarDropIndex === sourceIndex + 1
  ) {
    return
  }

  if (args.usesProjectGroupOrdering && draggedGroupRepo) {
    const siblings = sidebarRepoHeaderIds
      .filter((repoId) => repoId !== draggedOrderRepo.id)
      .map((repoId) => args.repoById.get(repoId))
      .filter((repo): repo is Repo => repo !== undefined)
    const siblingDropIndex = mapSidebarProjectHeaderDropIndexToSiblingInsertIndex({
      sidebarDropIndex,
      sourceIndex,
      siblingCount: siblings.length
    })
    // The original source slot is capped by the shorter sibling list after removing the dragged item.
    const sourceIndexInSiblings = Math.min(sourceIndex, siblings.length)
    if (siblingDropIndex === sourceIndexInSiblings) {
      return
    }
    const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds)
    const order = getProjectGroupOrderForSidebarDrop({
      siblings,
      dropIndex: siblingDropIndex,
      repoOrderRankById
    })
    args.onCommitProjectGroupOrder(draggedGroupRepo, draggedGroupRepo.projectGroupId ?? null, order)
    return
  }

  const insertAt = mapSidebarRepoDropIndexToAllRepoInsertAt(
    sidebarDropIndex,
    sidebarRepoHeaderIds,
    args.orderedRepoIds
  )
  const next = applyAllRepoInsertAt(args.orderedRepoIds, draggedOrderRepo.id, insertAt)
  if (!next) {
    return
  }
  args.onCommitRepoOrder(next)
}
