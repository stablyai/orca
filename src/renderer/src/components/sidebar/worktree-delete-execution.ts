import { useAppStore } from '@/store'
import { getWorktreeOnHostFromState } from '@/store/selectors'
import {
  isPathInsideOrEqual,
  normalizeRuntimePathForComparison
} from '../../../../shared/cross-platform-path'
import type { Worktree } from '../../../../shared/worktree/types'
import {
  composeWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../shared/worktree/host-qualified-identity'
import {
  toWorktreeRemovalTarget,
  type WorktreeRemovalTarget
} from '../../../../shared/worktree/removal'
import { prepareActiveWorktreeFocusAfterDelete } from './active-worktree-focus-after-delete'
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
  // Batch focus is committed once after every target settles.
  const activeWorktreeIdBefore = useAppStore.getState().activeWorktreeId
  const commitBatchFocus = activeWorktreeIdBefore
    ? prepareActiveWorktreeFocusAfterDelete(activeWorktreeIdBefore)
    : null
  // Mark all targets up front so the sidebar shows immediate progress.
  useAppStore
    .getState()
    .markWorktreesDeleting(uniqueTargets.map((target) => (target.hostId ? target : target.id)))
  // Git worktree removal shares repo locks only within one execution host.
  const groups = new Map<string, (typeof uniqueTargets)[number][]>()
  for (const target of uniqueTargets) {
    const groupIdentity = composeWorktreeHostIdentity(target.hostId, target.repoId)
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
        for (const target of group) {
          await runInWorktreeDeleteTurn(target.id, async () => {
            // A queued target may be recreated while an earlier repo sibling is deleting.
            // Why by host (STA-4343): the id-keyed map keeps ONE row per `repoId::path`,
            // so on a two-host collision it can hand back the other host's row — whose
            // instanceId never matches, silently dropping a delete the user confirmed.
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
                focusSuccessorOnDelete: false,
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
        }
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
  // Intermediate focus can spawn a terminal in another target that is still queued.
  if (activeWorktreeIdBefore) {
    const state = useAppStore.getState()
    const activeRow = getWorktreeOnHostFromState(
      state,
      activeWorktreeIdBefore,
      state.activeWorkspaceExecutionHostId ?? undefined
    )
    if (!activeRow) {
      commitBatchFocus?.()
    }
  }
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

/** Shared confirmed and skip-confirm execution with consistent failure recovery. */

export { runWorktreeDeleteWithToast }
