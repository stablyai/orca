import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import type { Repo } from '../../../../../../shared/repository/repo-types'
import {
  isProjectGroupStillInExpectedParent,
  isRepoStillInExpectedProjectGroup
} from './group-header-hit-geometry'
import {
  buildProjectGroupRollbackPatch,
  captureGroupRollback,
  captureRepoRollback,
  isGroupRollbackEntryStillLive,
  isRepoRollbackEntryStillLive,
  resolvePartialPrimaryRepoSnapshot
} from './project-group-drag-rollback-snapshots'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'

export { buildProjectGroupRollbackPatch }

export async function invokeBoolCallback(
  fn: () => Promise<boolean> | boolean | void
): Promise<boolean> {
  try {
    return (await fn()) !== false
  } catch {
    return false
  }
}

export async function reconcileHostSafely(
  onReconcileHostProjectGroups:
    | ((ownerHostId: ExecutionHostId) => Promise<void> | void)
    | undefined,
  ownerHostId: ExecutionHostId | null | undefined
): Promise<void> {
  if (!onReconcileHostProjectGroups || !ownerHostId) {
    return
  }
  try {
    await onReconcileHostProjectGroups(ownerHostId)
  } catch {
    // Best-effort reconciliation; failed drops still report false.
  }
}

export type MixedChildDropMutation =
  | { kind?: 'group'; groupId: string; updates: ProjectGroupHeaderUpdatePatch }
  | { kind: 'repo'; repo: Repo; projectGroupId: string | null; order: number }

export type RollbackGroupUpdateFn = (
  groupId: string,
  updates: ProjectGroupHeaderUpdatePatch
) => Promise<boolean> | boolean | void

export type RollbackRepoOrderFn = (
  project: Repo,
  projectGroupId: string | null,
  order: number | null,
  options?: { isPinned?: boolean }
) => Promise<boolean> | boolean | void

function isRepoDropMutation(
  mutation: MixedChildDropMutation
): mutation is { kind: 'repo'; repo: Repo; projectGroupId: string | null; order: number } {
  return mutation.kind === 'repo'
}

export type MixedChildRollbackEntry =
  | {
      kind: 'group'
      groupId: string
      patch: ProjectGroupHeaderUpdatePatch
      expectedLiveParentGroupId: string | null
      expectedLiveTabOrder?: number
      expectedLiveRootProjectOrder?: number | null
      expectedLiveIsPinned?: boolean
    }
  | {
      kind: 'repo'
      repo: Repo
      previousProjectGroupId: string | null
      previousOrder: number | null
      previousIsPinned: boolean
      expectedLiveProjectGroupId: string | null
      expectedLiveOrder: number | null
      expectedLiveIsPinned?: boolean
    }

export async function revertAppliedMixedChildRollbacks(args: {
  appliedRollbacks: readonly MixedChildRollbackEntry[]
  ownerHostId: ExecutionHostId | null | undefined
  getLiveProjectGroups: (() => readonly ProjectGroup[]) | undefined
  getLiveRepos: (() => readonly Repo[]) | undefined
  fallbackProjectGroupById: ReadonlyMap<string, ProjectGroup>
  fallbackRepoById: ReadonlyMap<string, Repo> | undefined
  onCommitProjectGroupUpdate: RollbackGroupUpdateFn
  onCommitProjectGroupOrder?: RollbackRepoOrderFn
}): Promise<boolean> {
  for (const entry of args.appliedRollbacks.toReversed()) {
    const liveGroups = args.getLiveProjectGroups?.()
    const liveRepos = args.getLiveRepos?.()
    if (entry.kind === 'group') {
      if (
        liveGroups &&
        !isGroupRollbackEntryStillLive({
          groupId: entry.groupId,
          expectedLiveParentGroupId: entry.expectedLiveParentGroupId,
          expectedLiveTabOrder: entry.expectedLiveTabOrder,
          expectedLiveRootProjectOrder: entry.expectedLiveRootProjectOrder,
          expectedLiveIsPinned: entry.expectedLiveIsPinned,
          hasExpectedLiveRootProjectOrder: 'expectedLiveRootProjectOrder' in entry,
          hasExpectedLiveIsPinned: 'expectedLiveIsPinned' in entry,
          ownerHostId: args.ownerHostId,
          liveProjectGroups: liveGroups,
          fallbackProjectGroupById: args.fallbackProjectGroupById
        })
      ) {
        continue
      }
      if (
        !(await invokeBoolCallback(() =>
          args.onCommitProjectGroupUpdate(entry.groupId, entry.patch)
        ))
      ) {
        return false
      }
      continue
    }
    const commitOrder = args.onCommitProjectGroupOrder
    if (!commitOrder) {
      return false
    }
    let livePinned = false
    if (liveRepos) {
      const check = isRepoRollbackEntryStillLive({
        repo: entry.repo,
        expectedLiveProjectGroupId: entry.expectedLiveProjectGroupId,
        expectedLiveOrder: entry.expectedLiveOrder,
        expectedLiveIsPinned: entry.expectedLiveIsPinned,
        hasExpectedLiveIsPinned: 'expectedLiveIsPinned' in entry,
        liveRepos,
        fallbackRepoById: args.fallbackRepoById
      })
      if (!check.stillLive) {
        continue
      }
      livePinned = check.livePinned
    }
    const restorePin =
      entry.previousIsPinned &&
      ((entry.previousProjectGroupId ?? null) !== entry.expectedLiveProjectGroupId ||
        (liveRepos !== undefined && !livePinned))
    const reverted = await invokeBoolCallback(() =>
      restorePin
        ? commitOrder(entry.repo, entry.previousProjectGroupId, entry.previousOrder, {
            isPinned: true
          })
        : commitOrder(entry.repo, entry.previousProjectGroupId, entry.previousOrder)
    )
    if (!reverted) {
      return false
    }
  }
  return true
}

export async function executeOrderedDropMutations(args: {
  primaryMutation?: MixedChildDropMutation
  mutations: readonly MixedChildDropMutation[]
  expectedParentGroupId: string | null
  ownerHostId: ExecutionHostId | null | undefined
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  repoById?: ReadonlyMap<string, Repo>
  getLiveProjectGroups?: () => readonly ProjectGroup[]
  getLiveRepos?: () => readonly Repo[]
  onCommitProjectGroupUpdate: RollbackGroupUpdateFn
  onCommitProjectGroupOrder?: RollbackRepoOrderFn
  onReconcileHostProjectGroups?: (ownerHostId: ExecutionHostId) => Promise<void> | void
  onDropFailed?: () => void
  onAfterMutations?: () => Promise<boolean>
}): Promise<boolean> {
  const orderedMutations = args.primaryMutation
    ? [args.primaryMutation, ...args.mutations.filter((m) => m !== args.primaryMutation)]
    : [...args.mutations]

  const appliedRollbacks: MixedChildRollbackEntry[] = []
  let reconcileUncertainPrimary = false
  const applySingle = (mutation: MixedChildDropMutation): Promise<boolean> =>
    invokeBoolCallback(() =>
      isRepoDropMutation(mutation)
        ? args.onCommitProjectGroupOrder?.(mutation.repo, mutation.projectGroupId, mutation.order)
        : args.onCommitProjectGroupUpdate(mutation.groupId, mutation.updates)
    )
  const rollbackApplied = async (notifyDropFailed: boolean): Promise<false> => {
    const rollbackSucceeded = await revertAppliedMixedChildRollbacks({
      appliedRollbacks,
      ownerHostId: args.ownerHostId,
      getLiveProjectGroups: args.getLiveProjectGroups,
      getLiveRepos: args.getLiveRepos,
      fallbackProjectGroupById: args.projectGroupById,
      fallbackRepoById: args.repoById,
      onCommitProjectGroupUpdate: args.onCommitProjectGroupUpdate,
      onCommitProjectGroupOrder: args.onCommitProjectGroupOrder
    })
    if (!rollbackSucceeded || reconcileUncertainPrimary) {
      await reconcileHostSafely(args.onReconcileHostProjectGroups, args.ownerHostId)
    }
    if (notifyDropFailed) {
      args.onDropFailed?.()
    }
    return false
  }

  for (const mutation of orderedMutations) {
    if (mutation !== args.primaryMutation) {
      const stillValid = isRepoDropMutation(mutation)
        ? isRepoStillInExpectedProjectGroup({
            repo: mutation.repo,
            expectedProjectGroupId: mutation.projectGroupId,
            liveRepos: args.getLiveRepos?.(),
            fallbackRepoById: args.repoById
          })
        : isProjectGroupStillInExpectedParent({
            groupId: mutation.groupId,
            expectedParentGroupId: args.expectedParentGroupId,
            ownerHostId: args.ownerHostId,
            liveProjectGroups: args.getLiveProjectGroups?.(),
            fallbackProjectGroupById: args.projectGroupById
          })
      if (!stillValid) {
        continue
      }
    }

    const capturedRepo = isRepoDropMutation(mutation)
      ? captureRepoRollback({
          repo: mutation.repo,
          liveRepos: args.getLiveRepos?.(),
          fallbackRepoById: args.repoById
        })
      : null
    const capturedGroup = isRepoDropMutation(mutation)
      ? null
      : captureGroupRollback({
          groupId: mutation.groupId,
          updates: mutation.updates,
          ownerHostId: args.ownerHostId,
          liveProjectGroups: args.getLiveProjectGroups?.(),
          fallbackProjectGroupById: args.projectGroupById
        })

    if (!(await applySingle(mutation))) {
      if (mutation === args.primaryMutation && isRepoDropMutation(mutation) && capturedRepo) {
        const resolution = resolvePartialPrimaryRepoSnapshot({
          mutation,
          capturedRepo,
          liveRepos: args.getLiveRepos?.()
        })
        if (resolution.kind === 'rollback') {
          appliedRollbacks.push({
            kind: 'repo',
            ...capturedRepo,
            expectedLiveProjectGroupId: resolution.expectedLiveProjectGroupId,
            expectedLiveOrder: resolution.expectedLiveOrder,
            expectedLiveIsPinned: resolution.expectedLiveIsPinned
          })
        } else if (resolution.kind === 'reconcile') {
          reconcileUncertainPrimary = true
        }
      }
      return rollbackApplied(
        !isRepoDropMutation(mutation) && mutation.updates.parentGroupId === undefined
      )
    }

    if (isRepoDropMutation(mutation)) {
      if (capturedRepo) {
        appliedRollbacks.push({
          kind: 'repo',
          ...capturedRepo,
          expectedLiveProjectGroupId: mutation.projectGroupId,
          expectedLiveOrder: mutation.order,
          expectedLiveIsPinned:
            mutation.projectGroupId !== capturedRepo.previousProjectGroupId
              ? false
              : capturedRepo.previousIsPinned
        })
      }
      continue
    }
    if (capturedGroup?.patch) {
      appliedRollbacks.push({
        kind: 'group',
        groupId: mutation.groupId,
        patch: capturedGroup.patch,
        expectedLiveParentGroupId: args.expectedParentGroupId,
        expectedLiveIsPinned:
          mutation.updates.parentGroupId !== undefined
            ? mutation.updates.isPinned === true
            : capturedGroup.previousIsPinned,
        ...(mutation.updates.tabOrder !== undefined
          ? { expectedLiveTabOrder: mutation.updates.tabOrder }
          : {}),
        ...('rootProjectOrder' in mutation.updates
          ? { expectedLiveRootProjectOrder: mutation.updates.rootProjectOrder ?? null }
          : {})
      })
    }
  }
  if (args.onAfterMutations && !(await args.onAfterMutations())) {
    return rollbackApplied(true)
  }
  return true
}
