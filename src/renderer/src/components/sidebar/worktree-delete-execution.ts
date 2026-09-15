import { captureWorktreeDeleteLineage } from './worktree-delete-lineage-validation'
import { getBlockedDeletionDependencies } from './worktree-delete-dependencies'
import { useAppStore } from '@/store'
import { getRepoHostSummaries } from '@/store/slices/worktrees/listing/worktree-host-ownership'
import {
  clearWorktreeDeleteTargetState,
  showBlockedWorktreeDelete
} from './worktree-delete-target-state'
import { getProjectedWorktreeLineage } from './worktree-lineage-projection'
import {
  getWorktreeLineageRuntimeOwner,
  isValidResolvedWorktreeLineageEdge
} from '../../../../shared/resolved-worktree-lineage'
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

export async function runWorktreeDeletesInParallel(
  targets: readonly Pick<
    Worktree,
    'id' | 'instanceId' | 'displayName' | 'repoId' | 'path' | 'hostId' | 'runtimeOwnerEnvironmentId'
  >[],
  options: WorktreeDeleteWithToastOptions & { respectLineageDependencies?: boolean } = {}
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
  const snapshot = useAppStore.getState()
  const matchesConfirmedLineage = options.respectLineageDependencies
    ? captureWorktreeDeleteLineage(snapshot, uniqueTargets)
    : null
  const owners = snapshot.repos ? getRepoHostSummaries(snapshot.repos) : null
  const hostFor = (target: (typeof uniqueTargets)[number], catalog = owners) => {
    const owner = catalog?.get(target.repoId)
    return target.hostId ?? (owner?.count === 1 ? owner.onlyHostId : undefined)
  }
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
  const deletedTargets: WorktreeRemovalTarget[] = []
  const failedTargets = new Set<string>()
  const completed = new Map<string, Promise<void>>()
  const dependencies = new Map<string, typeof uniqueTargets>()
  for (const parent of uniqueTargets) {
    dependencies.set(
      getWorktreeHostIdentity(parent),
      options.respectLineageDependencies
        ? uniqueTargets.filter((child) => {
            if (
              child.id === parent.id ||
              hostFor(child) !== hostFor(parent) ||
              getWorktreeLineageRuntimeOwner(child) !== getWorktreeLineageRuntimeOwner(parent)
            ) {
              return false
            }
            const row = getWorktreeOnHostFromState(snapshot, child.id, child.hostId)
            const parentRow = getWorktreeOnHostFromState(snapshot, parent.id, parent.hostId)
            const lineage = row && getProjectedWorktreeLineage(row, snapshot.worktreeLineageById)
            return (
              isStrictDescendantPath(parent.path, child.path) ||
              Boolean(
                row &&
                parentRow &&
                lineage &&
                isValidResolvedWorktreeLineageEdge(row, parentRow, lineage)
              )
            )
          })
        : []
    )
  }
  const blockTarget = (target: (typeof uniqueTargets)[number], cyclic = false): void => {
    failedTargets.add(getWorktreeHostIdentity(target))
    showBlockedWorktreeDelete(target, cyclic)
  }
  const executeTarget = async (target: (typeof uniqueTargets)[number]): Promise<void> => {
    const identity = getWorktreeHostIdentity(target)
    const currentState = useAppStore.getState()
    const currentOwners = currentState.repos ? getRepoHostSummaries(currentState.repos) : null
    const currentTarget = getWorktreeOnHostFromState(currentState, target.id, target.hostId)
    if (
      !currentTarget ||
      (matchesConfirmedLineage && !matchesConfirmedLineage(target, currentState)) ||
      currentTarget.instanceId !== target.instanceId ||
      // Why: defensively reject a confirmed target whose repository ownership disappeared.
      (options.respectLineageDependencies && owners && !hostFor(target)) ||
      hostFor(currentTarget, currentOwners) !== hostFor(target) ||
      getWorktreeLineageRuntimeOwner(currentTarget) !== getWorktreeLineageRuntimeOwner(target)
    ) {
      clearWorktreeDeleteTargetState(target)
      if (options.respectLineageDependencies) {
        failedTargets.add(identity)
      }
      listChanged = true
      return
    }
    const blocked = options.respectLineageDependencies
      ? dependencies
          .get(identity)
          ?.some((child) => failedTargets.has(getWorktreeHostIdentity(child)))
      : uniqueTargets.some(
          (child) =>
            child.repoId === target.repoId &&
            child.hostId === target.hostId &&
            failedTargets.has(getWorktreeHostIdentity(child)) &&
            isStrictDescendantPath(target.path, child.path)
        )
    if (blocked) {
      if (options.respectLineageDependencies) {
        blockTarget(target)
      } else {
        clearWorktreeDeleteTargetState(target)
      }
      return
    }
    const deleted = await runWorktreeDeleteWithToast(
      { ...toWorktreeRemovalTarget(target), executionHostId: hostFor(target) ?? null },
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
      deletedTargets.push(toWorktreeRemovalTarget(target))
      return
    }
    failedTargets.add(identity)
  }
  const schedule = (
    target: (typeof uniqueTargets)[number],
    ancestors = new Set<string>()
  ): Promise<void> => {
    const identity = getWorktreeHostIdentity(target)
    if (ancestors.has(identity)) {
      blockTarget(target)
      return Promise.resolve()
    }
    const pending = completed.get(identity)
    if (pending) {
      return pending
    }
    const nextAncestors = new Set([...ancestors, identity])
    const operation = Promise.resolve().then(async () => {
      await Promise.all(
        (dependencies.get(identity) ?? []).map((child) => schedule(child, nextAncestors))
      )
      await runInWorktreeDeleteTurn(composeWorktreeHostIdentity(target.hostId, target.repoId), () =>
        runInWorktreeDeleteTurn(target.id, () => executeTarget(target))
      )
    })
    completed.set(identity, operation)
    return operation
  }
  try {
    if (options.respectLineageDependencies) {
      const blocked = getBlockedDeletionDependencies(dependencies)
      for (const target of uniqueTargets) {
        const identity = getWorktreeHostIdentity(target)
        if (blocked.has(identity)) {
          blockTarget(target, true)
          completed.set(identity, Promise.resolve())
        }
      }
      await Promise.all(uniqueTargets.map((target) => schedule(target)))
    } else {
      await Promise.all(
        Array.from(groups.values()).map(async (group) => {
          for (const target of group) {
            await runInWorktreeDeleteTurn(target.id, () => executeTarget(target))
          }
        })
      )
    }
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
    deletedTargets.map((target) =>
      composeWorktreeHostIdentity(target.executionHostId ?? undefined, target.id)
    )
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
