import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import { getLogicalRepoOrderRankById } from '../../../../../../shared/sidebar-list/sections/project-section-order'
import { getNextRootProjectOrder } from '../../../../../../shared/sidebar-list/sections/root-project-order'
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
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  type ProjectHeaderDragSession
} from './project-header-drag-contract'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import type { RootProjectHeaderDrag } from './root-project-header-drop'
import { invokeBoolCallback } from './project-group-header-drag-rollback'
import {
  commitInterleavedRootProjectHeaderDrop,
  resolveSiblingRepoForDraggedHost
} from './project-header-root-drop-commit'

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
    orderedRepoIds: readonly string[]
    repoById: ReadonlyMap<string, Repo>
    liveRepos: readonly Repo[]
    getLiveRepos?: () => readonly Repo[]
    projectGroups?: readonly ProjectGroup[]
    projectGroupById?: ReadonlyMap<string, ProjectGroup>
    usesProjectGroupOrdering: boolean
    onCommitRepoOrder: (orderedIds: string[]) => void
    onCommitProjectGroupOrder: (
      project: Repo,
      projectGroupId: string | null,
      order: number | null
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

  if (args.dropTarget.targetBucketKey !== args.session.bucketKey) {
    if (
      !draggedGroupRepo ||
      getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey
    ) {
      return false
    }
    const targetGroupId = parseGroupIdFromBucketKey(args.dropTarget.targetBucketKey)
    const targetHeaderIds =
      args.sidebarRepoHeaderIdsByBucket.get(args.dropTarget.targetBucketKey) ?? []
    const draggedHostId = getRepoExecutionHostId(draggedGroupRepo)
    const siblings: Repo[] = []
    let siblingDropIndex = 0
    const sidebarDropIndex = args.dropTarget.dropIndex
    // dropIndex is a slot in the full destination bucket; count only resolvable siblings before it.
    targetHeaderIds.forEach((repoId, index) => {
      if (repoId === draggedGroupRepo.id) {
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
      if (index < sidebarDropIndex) {
        siblingDropIndex++
      }
      siblings.push(sibling)
    })
    const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds)
    const order =
      targetGroupId === null && siblings.length === 0 && args.projectGroups
        ? (getNextRootProjectOrder(args.liveRepos, args.projectGroups) ?? 0)
        : getProjectGroupOrderForSidebarDrop({
            siblings,
            dropIndex: siblingDropIndex,
            repoOrderRankById
          })
    return invokeBoolCallback(() =>
      args.onCommitProjectGroupOrder(draggedGroupRepo, targetGroupId, order)
    )
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
  const sidebarRepoHeaderIds = args.session.sidebarRepoHeaderIds
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
    return invokeBoolCallback(() =>
      args.onCommitProjectGroupOrder(
        draggedGroupRepo,
        draggedGroupRepo.projectGroupId ?? null,
        order
      )
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
