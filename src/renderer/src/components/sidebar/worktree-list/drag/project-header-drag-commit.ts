import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import { isRepoHeaderIdPinned } from './header-drag-pin-tier'
import { computeProjectGroupChildDropMutations } from './project-group-child-drop-commit'
import type { ProjectGroupChildItemId } from './project-group-child-slot-order'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'
import { executeOrderedDropMutations } from './project-group-header-drag-rollback'
import { computeCrossBucketProjectGroupMutations } from './project-header-bucket-slot-drop'
import {
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  type ProjectHeaderDragSession
} from './project-header-drag-contract'
import {
  applyAllRepoInsertAt,
  getProjectHeaderDragBucketKey,
  getProjectGroupOrderForSidebarDrop,
  mapSidebarRepoDropIndexToAllRepoInsertAt,
  type ProjectHeaderDragBucketKey
} from './project-header-drop'
import {
  parseGroupIdFromBucketKey,
  type ProjectHeaderDropTarget
} from './project-header-group-drop'
import {
  commitInterleavedRootProjectHeaderDrop,
  commitProjectGroupOrderStep,
  resolveSiblingRepoForDraggedHost
} from './project-header-root-drop-commit'
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
    getLiveRepos?: () => readonly Repo[]
    getLiveProjectGroups?: () => readonly ProjectGroup[]
    projectGroups?: readonly ProjectGroup[]
    usesProjectGroupOrdering: boolean
    onCommitRepoOrder: (orderedIds: string[]) => void
    onCommitProjectGroupOrder: (
      project: Repo,
      projectGroupId: string | null,
      order: number | null,
      options?: { isPinned?: boolean }
    ) => Promise<boolean> | boolean | void
    onCommitProjectGroupUpdate?: (
      groupId: string,
      updates: ProjectGroupHeaderUpdatePatch
    ) => Promise<boolean> | boolean | void
    onReconcileHostProjectGroups?: (ownerHostId: ExecutionHostId) => Promise<void> | void
    onDropFailed?: () => void
    onMoveToGroupHeader: (project: Repo, groupId: string) => void
  }
): Promise<boolean> {
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
      return false
    }
    if ((draggedGroupRepo.projectGroupId ?? null) !== args.dropTarget.groupId) {
      args.onMoveToGroupHeader(draggedGroupRepo, args.dropTarget.groupId)
    }
    return true
  }

  if (
    args.dropTarget.targetBucketKey === ROOT_INTERLEAVED_PROJECT_BUCKET_KEY &&
    args.session.rootProjectHeaderKeys
  ) {
    return commitInterleavedRootProjectHeaderDrop({
      ...args,
      draggedGroupRepo,
      dropIndex: args.dropTarget.dropIndex
    })
  }

  const targetGroupId = parseGroupIdFromBucketKey(args.dropTarget.targetBucketKey)
  if (
    targetGroupId !== null &&
    draggedGroupRepo &&
    args.sidebarGroupChildItemIdsByGroupId &&
    args.projectGroupById
  ) {
    if (getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey) {
      return false
    }
    const isCrossBucket = args.dropTarget.targetBucketKey !== args.session.bucketKey
    const mutations = computeProjectGroupChildDropMutations({
      parentGroupId: targetGroupId,
      draggedItem: {
        kind: 'repo',
        repo: draggedGroupRepo,
        headerRepoId: args.session.repo.id
      },
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
    return executeOrderedDropMutations({
      primaryMutation,
      mutations,
      expectedParentGroupId: targetGroupId,
      ownerHostId: getRepoExecutionHostId(draggedGroupRepo),
      projectGroupById: args.projectGroupById,
      repoById: args.repoById,
      getLiveProjectGroups: args.getLiveProjectGroups,
      getLiveRepos: args.getLiveRepos,
      onCommitProjectGroupUpdate: args.onCommitProjectGroupUpdate ?? (async () => false),
      onCommitProjectGroupOrder: args.onCommitProjectGroupOrder,
      onReconcileHostProjectGroups: args.onReconcileHostProjectGroups,
      onDropFailed: args.onDropFailed
    })
  }

  if (args.dropTarget.targetBucketKey !== args.session.bucketKey) {
    if (
      !draggedGroupRepo ||
      getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey
    ) {
      return false
    }
    const crossMutations = computeCrossBucketProjectGroupMutations({
      draggedGroupRepo,
      targetBucketHeaderIds:
        args.sidebarRepoHeaderIdsByBucket.get(args.dropTarget.targetBucketKey) ?? [],
      targetGroupId,
      dropIndex: args.dropTarget.dropIndex,
      pinnedRepoHeaderIds: args.pinnedRepoHeaderIds,
      repoById: args.repoById,
      liveRepos: args.liveRepos,
      orderedRepoIds: args.orderedRepoIds,
      projectGroups: args.projectGroups
    })
    return executeOrderedDropMutations({
      primaryMutation: crossMutations[0],
      mutations: crossMutations,
      expectedParentGroupId: targetGroupId,
      ownerHostId: getRepoExecutionHostId(draggedGroupRepo),
      projectGroupById: args.projectGroupById ?? new Map(),
      repoById: args.repoById,
      getLiveProjectGroups: args.getLiveProjectGroups,
      getLiveRepos: args.getLiveRepos,
      onCommitProjectGroupUpdate: args.onCommitProjectGroupUpdate ?? (async () => false),
      onCommitProjectGroupOrder: args.onCommitProjectGroupOrder,
      onReconcileHostProjectGroups: args.onReconcileHostProjectGroups,
      onDropFailed: args.onDropFailed
    })
  }

  // Why: a group change mid-drag (another window or client) moved the row out of this bucket.
  const bucketLiveRepo = draggedGroupRepo ?? draggedOrderRepo
  if (
    !draggedOrderRepo ||
    !bucketLiveRepo ||
    getProjectHeaderDragBucketKey(bucketLiveRepo) !== args.session.bucketKey
  ) {
    return false
  }

  const sidebarDropIndex = args.dropTarget.dropIndex
  const fallbackHostId = getRepoExecutionHostId(bucketLiveRepo)
  const draggedPinned =
    isRepoHeaderIdPinned(
      draggedOrderRepo.id,
      args.pinnedRepoHeaderIds,
      args.repoById,
      fallbackHostId,
      args.liveRepos
    ) || bucketLiveRepo.isPinned === true
  const sidebarRepoHeaderIds = args.session.sidebarRepoHeaderIds.filter(
    (repoId) =>
      isRepoHeaderIdPinned(
        repoId,
        args.pinnedRepoHeaderIds,
        args.repoById,
        fallbackHostId,
        args.liveRepos
      ) === draggedPinned
  )
  const sourceIndex = sidebarRepoHeaderIds.indexOf(draggedOrderRepo.id)
  // Both slots beside the dragged header are no-ops; do not compact paired-host occurrences.
  if (
    sourceIndex === -1 ||
    sidebarDropIndex === sourceIndex ||
    sidebarDropIndex === sourceIndex + 1
  ) {
    return true
  }

  if (args.usesProjectGroupOrdering && draggedGroupRepo) {
    const draggedHostId = getRepoExecutionHostId(draggedGroupRepo)
    const siblings: Repo[] = []
    let siblingDropIndex = 0
    let sourceIndexInSiblings = 0
    // Count resolvable siblings before each full-bucket slot so both indices share one coordinate space.
    sidebarRepoHeaderIds.forEach((repoId, index) => {
      if (repoId === draggedOrderRepo.id) {
        return
      }
      const sibling = resolveSiblingRepoForDraggedHost(
        repoId,
        draggedHostId,
        args.liveRepos,
        args.repoById
      )
      if (!sibling) {
        return
      }
      if (index < sourceIndex) {
        sourceIndexInSiblings++
      }
      if (index < sidebarDropIndex) {
        siblingDropIndex++
      }
      siblings.push(sibling)
    })
    if (siblingDropIndex === sourceIndexInSiblings) {
      return true
    }
    const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds)
    const order = getProjectGroupOrderForSidebarDrop({
      siblings,
      dropIndex: siblingDropIndex,
      repoOrderRankById
    })
    return commitProjectGroupOrderStep(
      args.onCommitProjectGroupOrder,
      draggedGroupRepo,
      draggedGroupRepo.projectGroupId ?? null,
      order
    )
  }

  const insertAt = mapSidebarRepoDropIndexToAllRepoInsertAt(
    sidebarDropIndex,
    sidebarRepoHeaderIds,
    args.orderedRepoIds
  )
  const next = applyAllRepoInsertAt(args.orderedRepoIds, draggedOrderRepo.id, insertAt)
  if (!next) {
    return true
  }
  args.onCommitRepoOrder(next)
  return true
}
