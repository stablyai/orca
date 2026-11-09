import { getLogicalRepoOrderRankById } from '../../../../../../shared/project-section-order'
import { getNextRootProjectOrder } from '../../../../../../shared/root-project-order'
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
import {
  ROOT_INTERLEAVED_PROJECT_BUCKET_KEY,
  type ProjectHeaderDragSession
} from './project-header-drag-contract'
import type { ProjectGroup } from '../../../../../../shared/project-group-types'
import type { Repo } from '../../../../../../shared/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export function commitProjectHeaderDragDrop(
  args: RootProjectHeaderDrag & {
    session: Pick<
      ProjectHeaderDragSession,
      'repo' | 'groupRepo' | 'bucketKey' | 'sidebarRepoHeaderIds' | 'rootProjectHeaderKeys'
    >
    dropTarget: ProjectHeaderDropTarget
    sidebarRepoHeaderIdsByBucket: ReadonlyMap<ProjectHeaderDragBucketKey, readonly string[]>
    orderedRepoIds: readonly string[]
    repoById: ReadonlyMap<string, Repo>
    liveRepos: readonly Repo[]
    projectGroups?: readonly ProjectGroup[]
    usesProjectGroupOrdering: boolean
    onCommitRepoOrder: (orderedIds: string[]) => void
    onCommitProjectGroupOrder: (project: Repo, projectGroupId: string | null, order: number) => void
    onMoveToGroupHeader: (project: Repo, groupId: string) => void
  }
): void {
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
    args.onCommitRootProjectOrder?.(
      args.session.rootProjectHeaderKeys,
      `repo:${args.session.repo.id}`,
      args.dropTarget.dropIndex
    )
    return
  }

  if (args.dropTarget.targetBucketKey !== args.session.bucketKey) {
    if (
      !draggedGroupRepo ||
      getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey
    ) {
      return
    }
    const targetGroupId = parseGroupIdFromBucketKey(args.dropTarget.targetBucketKey)
    const targetHeaderIds =
      args.sidebarRepoHeaderIdsByBucket.get(args.dropTarget.targetBucketKey) ?? []
    const siblings = targetHeaderIds
      .filter((repoId) => repoId !== draggedGroupRepo.id)
      .map((repoId) => args.repoById.get(repoId))
      .filter((repo): repo is Repo => repo !== undefined)
    const clampedDropIndex = Math.max(0, Math.min(siblings.length, args.dropTarget.dropIndex))
    const repoOrderRankById = getLogicalRepoOrderRankById(args.orderedRepoIds)
    const order =
      targetGroupId === null && siblings.length === 0 && args.projectGroups
        ? (getNextRootProjectOrder(args.liveRepos, args.projectGroups) ?? 0)
        : getProjectGroupOrderForSidebarDrop({
            siblings,
            dropIndex: clampedDropIndex,
            repoOrderRankById
          })
    args.onCommitProjectGroupOrder(draggedGroupRepo, targetGroupId, order)
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
  const sidebarRepoHeaderIds = args.session.sidebarRepoHeaderIds
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
