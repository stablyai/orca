import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/worktree/types'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../shared/execution-host'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import {
  toWorktreeRemovalTarget,
  type WorktreeRemovalTarget
} from '../../../../shared/worktree/removal'
import { showWorkspaceListChangedToast } from './stale-workspace-list-toast'
import { showPreservedBranchBatchToast } from './preserved-branch-batch-toast'
import type { PreservedBranchCleanup } from '@/lib/preserved-branch-cleanup'
import type { WorktreeDeleteWithToastOptions } from './worktree-delete-request'
import { beginWorktreeSnapshotPruneBatch } from './worktree-snapshot-prune-batch'
import { runWorktreeDeleteWithToast } from './run-worktree-delete-with-toast'

function isStrictDescendantPath(parentPath: string, childPath: string): boolean {
  return (
    normalizeRuntimePathForComparison(parentPath) !==
      normalizeRuntimePathForComparison(childPath) && isPathInsideOrEqual(parentPath, childPath)
  )
}

function clearWorktreeDeleteTargetState(target: Pick<Worktree, 'id' | 'hostId'>): void {
  const state = useAppStore.getState()
  if (target.hostId) {
    state.clearWorktreeDeleteState(target.id, target.hostId)
  } else {
    state.clearWorktreeDeleteState(target.id)
  }
}

export async function runWorktreeDeletesInParallel(
  targets: readonly Pick<
    Worktree,
    'id' | 'instanceId' | 'displayName' | 'repoId' | 'path' | 'hostId'
  >[],
  options: WorktreeDeleteWithToastOptions = {}
): Promise<WorktreeRemovalTarget[]> {
  // A destructive command must run once per identity even if a refresh duplicated rows.
  const uniqueTargets = Array.from(
    new Map(targets.map((target) => [getWorktreeHostIdentity(target), target])).values()
  )
  // Mark all targets up front so the sidebar shows progress and no target is picked as the successor.
  useAppStore
    .getState()
    .markWorktreesDeleting(uniqueTargets.map((target) => (target.hostId ? target : target.id)))
  // Directory dependencies cross repositories, but never execution hosts.
  const groups = new Map<string, (typeof uniqueTargets)[number][]>()
  for (const target of uniqueTargets) {
    const groupIdentity = target.hostId ?? LOCAL_EXECUTION_HOST_ID
    const group = groups.get(groupIdentity)
    if (group) {
      group.push(target)
    } else {
      groups.set(groupIdentity, [target])
    }
  }
  for (const group of groups.values()) {
    // Children must leave first or Git rejects their registered ancestor.
    group.sort((a, b) => b.path.length - a.path.length)
  }
  const preservedBranches: PreservedBranchCleanup[] = []
  const aggregatePreservedBranches = uniqueTargets.length > 1
  let listChanged = false
  const pendingSnapshotPruneBatch =
    uniqueTargets.length > 1 ? beginWorktreeSnapshotPruneBatch() : null
  const snapshotPruneBatch = pendingSnapshotPruneBatch ? await pendingSnapshotPruneBatch : null
  const deletionTailByWorktreeId = new Map<string, Promise<void>>()
  const runInWorktreeDeleteTurn = async <T>(
    worktreeId: string,
    operation: () => Promise<T>
  ): Promise<T> => {
    const previous = deletionTailByWorktreeId.get(worktreeId)
    let releaseTurn: () => void = () => {}
    const turn = new Promise<void>((resolve) => {
      releaseTurn = resolve
    })
    const tail = previous ? previous.then(() => turn) : turn
    deletionTailByWorktreeId.set(worktreeId, tail)
    if (previous) {
      await previous
    }
    try {
      return await operation()
    } finally {
      releaseTurn()
      if (deletionTailByWorktreeId.get(worktreeId) === tail) {
        deletionTailByWorktreeId.delete(worktreeId)
      }
    }
  }
  let groupResults: WorktreeRemovalTarget[][]
  try {
    groupResults = await Promise.all(
      Array.from(groups.values()).map(async (group) => {
        const deletedInGroup: WorktreeRemovalTarget[] = []
        const failedInGroup: (typeof group)[number][] = []
        const started: [(typeof group)[number], Promise<void>][] = []
        // Local hosts own per-repo cleanup locks and delete limits; SSH and older paired hosts
        // still need same-repo serialization here to avoid racing ref locks (#2259).
        const serialized = (group[0]?.hostId ?? LOCAL_EXECUTION_HOST_ID) !== LOCAL_EXECUTION_HOST_ID
        for (const target of group) {
          const repoTail = serialized
            ? started.findLast(([earlier]) => earlier.repoId === target.repoId)
            : undefined
          const dependencies = started.filter(
            (entry) => entry === repoTail || isStrictDescendantPath(target.path, entry[0].path)
          )
          const settled = runInWorktreeDeleteTurn(target.id, async () => {
            // Wait inside the operation so unrelated repositories can still start.
            if (dependencies.length > 0) {
              await Promise.all(dependencies.map(([, earlier]) => earlier))
            }
            // Recheck the queued instance on its confirmed host; an ID-only lookup can return a twin instead.
            const currentTarget = getWorktreeOnHostFromState(
              useAppStore.getState(),
              target.id,
              target.hostId
            )
            if (!currentTarget || currentTarget.instanceId !== target.instanceId) {
              clearWorktreeDeleteTargetState(target)
              listChanged = true
              return
            }
            if (failedInGroup.some((failed) => isStrictDescendantPath(target.path, failed.path))) {
              clearWorktreeDeleteTargetState(target)
              return
            }
            const deleted = await runWorktreeDeleteWithToast(
              toWorktreeRemovalTarget(target),
              target.displayName,
              {
                ...options,
                suppressPreservedBranchToast: aggregatePreservedBranches,
                ...(snapshotPruneBatch ? { snapshotPruneBatchId: snapshotPruneBatch.batchId } : {}),
                onPreservedBranch: (branch) => {
                  preservedBranches.push(branch)
                  options.onPreservedBranch?.(branch)
                }
              }
            )
            if (deleted) {
              deletedInGroup.push(toWorktreeRemovalTarget(target))
            } else {
              // A failed child makes deleting its ancestor unsafe because the child lives below it.
              failedInGroup.push(target)
            }
          })
          started.push([target, settled])
        }
        await Promise.all(started.map(([, settled]) => settled))
        return deletedInGroup
      })
    )
  } finally {
    if (snapshotPruneBatch) {
      try {
        await snapshotPruneBatch.finish()
      } catch (error) {
        console.warn('Failed to finish workspace snapshot prune batch:', error)
      }
    }
  }
  if (listChanged) {
    showWorkspaceListChangedToast()
  }
  const deletedIdentities = new Set(
    groupResults
      .flat()
      .map((target) => composeWorktreeHostIdentity(target.executionHostId ?? undefined, target.id))
  )
  if (aggregatePreservedBranches && preservedBranches.length > 0) {
    const targetOrder = new Map(
      uniqueTargets.map((target, index) => [getWorktreeHostIdentity(target), index])
    )
    preservedBranches.sort(
      (left, right) =>
        (targetOrder.get(composeWorktreeHostIdentity(left.hostId, left.worktreeId)) ??
          Number.MAX_SAFE_INTEGER) -
        (targetOrder.get(composeWorktreeHostIdentity(right.hostId, right.worktreeId)) ??
          Number.MAX_SAFE_INTEGER)
    )
    showPreservedBranchBatchToast(deletedIdentities.size, preservedBranches)
  }
  return uniqueTargets
    .filter((target) => deletedIdentities.has(getWorktreeHostIdentity(target)))
    .map(toWorktreeRemovalTarget)
}

export { runWorktreeDeleteWithToast }
