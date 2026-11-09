import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import { isSameRepoRow } from '@/store/repos/repo-host-identity'
import { invokeBoolCallback, reconcileHostSafely } from './project-group-header-drag-rollback'
import type { ProjectHeaderDragSession } from './project-header-drag-contract'
import { getProjectHeaderDragBucketKey } from './project-header-drop'
import {
  resolveSiblingRepoForDraggedHost,
  resolveUngroupedRepoInterleavedRootPlacement
} from './project-header-root-ungroup-order'
import type { RootProjectHeaderDrag } from './root-project-header-drop'

export { resolveSiblingRepoForDraggedHost }

export async function commitInterleavedRootProjectHeaderDrop(
  args: RootProjectHeaderDrag & {
    draggedGroupRepo: Repo | undefined
    session: Pick<
      ProjectHeaderDragSession,
      'repo' | 'bucketKey' | 'rootProjectHeaderKeys' | 'rootProjectHeaderHostId'
    >
    dropIndex: number
    projectGroupById?: ReadonlyMap<string, ProjectGroup>
    projectGroups?: readonly ProjectGroup[]
    orderedRepoIds: readonly string[]
    repoById: ReadonlyMap<string, Repo>
    liveRepos: readonly Repo[]
    getLiveRepos?: () => readonly Repo[]
    onCommitProjectGroupOrder: (
      project: Repo,
      projectGroupId: string | null,
      order: number | null
    ) => Promise<boolean> | boolean | void
    onReconcileHostProjectGroups?: (ownerHostId: ExecutionHostId) => Promise<void> | void
    onDropFailed?: () => void
  }
): Promise<boolean> {
  if (args.session.bucketKey === 'ungrouped') {
    const commitRootOrder = args.onCommitRootProjectOrder
    if (!commitRootOrder) {
      return false
    }
    return invokeBoolCallback(() =>
      commitRootOrder(
        args.session.rootProjectHeaderKeys!,
        `repo:${args.session.repo.id}`,
        args.dropIndex
      )
    )
  }
  const draggedGroupRepo = args.draggedGroupRepo
  if (
    !draggedGroupRepo ||
    getProjectHeaderDragBucketKey(draggedGroupRepo) !== args.session.bucketKey
  ) {
    return false
  }
  const placement = resolveUngroupedRepoInterleavedRootPlacement({
    draggedRepo: draggedGroupRepo,
    dropIndex: args.dropIndex,
    rootProjectHeaderKeys: args.session.rootProjectHeaderKeys!,
    projectGroupById: args.projectGroupById,
    projectGroups: args.projectGroups,
    liveRepos: args.liveRepos,
    repoById: args.repoById,
    orderedRepoIds: args.orderedRepoIds
  })
  const previousGroupId = draggedGroupRepo.projectGroupId ?? null
  const previousOrder = draggedGroupRepo.projectGroupOrder ?? null
  const accepted = await invokeBoolCallback(() =>
    args.onCommitProjectGroupOrder(draggedGroupRepo, null, placement.order)
  )
  if (!accepted) {
    return false
  }
  if (placement.needsInterleavedRespace && args.onCommitRootProjectOrder) {
    const commitRootOrder = args.onCommitRootProjectOrder
    const respaceAccepted = await invokeBoolCallback(() =>
      commitRootOrder(
        placement.interleavedKeysWithRepo,
        `repo:${draggedGroupRepo.id}`,
        placement.clampedDropIndex
      )
    )
    if (!respaceAccepted) {
      const liveRepos = args.getLiveRepos?.()
      const liveRepo = liveRepos?.find((candidate) => isSameRepoRow(candidate, draggedGroupRepo))
      const stillMatchesDrop =
        liveRepos === undefined ||
        (liveRepo !== undefined &&
          (liveRepo.projectGroupId ?? null) === null &&
          (liveRepo.projectGroupOrder ?? null) === placement.order)
      if (!stillMatchesDrop) {
        return false
      }
      const reverted = await invokeBoolCallback(() =>
        args.onCommitProjectGroupOrder(draggedGroupRepo, previousGroupId, previousOrder)
      )
      if (!reverted) {
        await reconcileHostSafely(
          args.onReconcileHostProjectGroups,
          getRepoExecutionHostId(draggedGroupRepo)
        )
      }
      args.onDropFailed?.()
      return false
    }
  }
  return true
}
