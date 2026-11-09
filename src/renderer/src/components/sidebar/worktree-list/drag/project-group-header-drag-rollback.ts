import {
  getRepoExecutionHostId,
  type ExecutionHostId
} from '../../../../../../shared/execution-host/execution-host'
import type { ProjectGroup } from '../../../../../../shared/project/groups/project-group-types'
import { isProjectGroupStillInExpectedParent } from './group-header-hit-geometry'
import type { ProjectGroupHeaderUpdatePatch } from './project-group-header-drag-contract'

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

export type AppliedProjectGroupRollback = {
  groupId: string
  patch: ProjectGroupHeaderUpdatePatch
  expectedLiveParentGroupId: string | null
  expectedLiveTabOrder?: number
  expectedLiveRootProjectOrder?: number | null
}

export function buildProjectGroupRollbackPatch(
  group: ProjectGroup | undefined,
  updates: ProjectGroupHeaderUpdatePatch
): ProjectGroupHeaderUpdatePatch | null {
  if (!group) {
    return null
  }
  const patch: ProjectGroupHeaderUpdatePatch = {}
  if (updates.parentGroupId !== undefined) {
    patch.parentGroupId = group.parentGroupId ?? null
    patch.rootProjectOrder = group.rootProjectOrder ?? null
  }
  if (updates.tabOrder !== undefined) {
    patch.tabOrder = group.tabOrder
  }
  if (updates.rootProjectOrder !== undefined) {
    patch.rootProjectOrder = group.rootProjectOrder ?? null
  }
  return Object.keys(patch).length > 0 ? patch : null
}

export function captureProjectGroupMutationRollbacks(args: {
  mutations: readonly { groupId: string; updates: ProjectGroupHeaderUpdatePatch }[]
  ownerHostId: ExecutionHostId | null | undefined
  liveProjectGroups: readonly ProjectGroup[] | undefined
  fallbackProjectGroupById: ReadonlyMap<string, ProjectGroup>
}): Map<string, ProjectGroupHeaderUpdatePatch> {
  const rollbacks = new Map<string, ProjectGroupHeaderUpdatePatch>()
  for (const mutation of args.mutations) {
    if (rollbacks.has(mutation.groupId)) {
      continue
    }
    const preDropGroup =
      args.liveProjectGroups?.find(
        (candidate) =>
          candidate.id === mutation.groupId &&
          (!args.ownerHostId || getRepoExecutionHostId(candidate) === args.ownerHostId)
      ) ?? args.fallbackProjectGroupById.get(mutation.groupId)
    const patch = buildProjectGroupRollbackPatch(preDropGroup, mutation.updates)
    if (patch) {
      rollbacks.set(mutation.groupId, patch)
    }
  }
  return rollbacks
}

export async function revertAppliedProjectGroupRollbacks(args: {
  appliedRollbacks: readonly AppliedProjectGroupRollback[]
  ownerHostId: ExecutionHostId | null | undefined
  getLiveProjectGroups: (() => readonly ProjectGroup[]) | undefined
  fallbackProjectGroupById: ReadonlyMap<string, ProjectGroup>
  onCommitProjectGroupUpdate: (
    groupId: string,
    updates: ProjectGroupHeaderUpdatePatch
  ) => Promise<boolean> | boolean | void
}): Promise<boolean> {
  for (const entry of args.appliedRollbacks.toReversed()) {
    const liveGroups = args.getLiveProjectGroups?.()
    if (liveGroups) {
      if (
        !isProjectGroupStillInExpectedParent({
          groupId: entry.groupId,
          expectedParentGroupId: entry.expectedLiveParentGroupId,
          ownerHostId: args.ownerHostId,
          liveProjectGroups: liveGroups,
          fallbackProjectGroupById: args.fallbackProjectGroupById
        })
      ) {
        continue
      }
      const liveGroup = liveGroups.find(
        (candidate) =>
          candidate.id === entry.groupId &&
          (!args.ownerHostId || getRepoExecutionHostId(candidate) === args.ownerHostId)
      )
      if (
        !liveGroup ||
        (entry.expectedLiveTabOrder !== undefined &&
          liveGroup.tabOrder !== entry.expectedLiveTabOrder) ||
        ('expectedLiveRootProjectOrder' in entry &&
          (liveGroup.rootProjectOrder ?? null) !== entry.expectedLiveRootProjectOrder)
      ) {
        continue
      }
    }
    const reverted = await invokeBoolCallback(() =>
      args.onCommitProjectGroupUpdate(entry.groupId, entry.patch)
    )
    if (!reverted) {
      return false
    }
  }
  return true
}

export function buildAppliedGroupRollbackEntry(args: {
  groupId: string
  patch: ProjectGroupHeaderUpdatePatch
  expectedParentGroupId: string | null
  updates: ProjectGroupHeaderUpdatePatch
}): AppliedProjectGroupRollback {
  return {
    groupId: args.groupId,
    patch: args.patch,
    expectedLiveParentGroupId: args.expectedParentGroupId,
    ...(args.updates.tabOrder !== undefined ? { expectedLiveTabOrder: args.updates.tabOrder } : {}),
    ...('rootProjectOrder' in args.updates
      ? { expectedLiveRootProjectOrder: args.updates.rootProjectOrder ?? null }
      : {})
  }
}

export async function abortGroupDropWithRollback(args: {
  appliedRollbacks: readonly AppliedProjectGroupRollback[]
  ownerHostId: ExecutionHostId | null | undefined
  getLiveProjectGroups: (() => readonly ProjectGroup[]) | undefined
  fallbackProjectGroupById: ReadonlyMap<string, ProjectGroup>
  onCommitProjectGroupUpdate: (
    groupId: string,
    updates: ProjectGroupHeaderUpdatePatch
  ) => Promise<boolean> | boolean | void
  onReconcileHostProjectGroups?: (ownerHostId: ExecutionHostId) => Promise<void> | void
  onDropFailed?: () => void
}): Promise<false> {
  const rollbackSucceeded = await revertAppliedProjectGroupRollbacks(args)
  if (!rollbackSucceeded) {
    await reconcileHostSafely(args.onReconcileHostProjectGroups, args.ownerHostId)
  }
  args.onDropFailed?.()
  return false
}

export async function executeProjectGroupDropUpdates(args: {
  mutations: readonly { groupId: string; updates: ProjectGroupHeaderUpdatePatch }[]
  reparentMutation: { groupId: string; updates: ProjectGroupHeaderUpdatePatch } | undefined
  expectedParentGroupId: string | null
  ownerHostId: ExecutionHostId | null | undefined
  projectGroupById: ReadonlyMap<string, ProjectGroup>
  getLiveProjectGroups?: () => readonly ProjectGroup[]
  onCommitProjectGroupUpdate: (
    groupId: string,
    updates: ProjectGroupHeaderUpdatePatch
  ) => Promise<boolean> | boolean | void
  onReconcileHostProjectGroups?: (ownerHostId: ExecutionHostId) => Promise<void> | void
  onDropFailed?: () => void
}): Promise<{ ok: true; appliedRollbacks: AppliedProjectGroupRollback[] } | { ok: false }> {
  const preDropRollbacks = captureProjectGroupMutationRollbacks({
    mutations: args.mutations,
    ownerHostId: args.ownerHostId,
    liveProjectGroups: args.getLiveProjectGroups?.(),
    fallbackProjectGroupById: args.projectGroupById
  })
  const appliedRollbacks: AppliedProjectGroupRollback[] = []
  if (args.reparentMutation) {
    const { groupId, updates } = args.reparentMutation
    const reparentRollback = preDropRollbacks.get(groupId)
    if (!(await invokeBoolCallback(() => args.onCommitProjectGroupUpdate(groupId, updates)))) {
      return { ok: false }
    }
    if (reparentRollback) {
      appliedRollbacks.push(
        buildAppliedGroupRollbackEntry({
          groupId,
          patch: reparentRollback,
          expectedParentGroupId: args.expectedParentGroupId,
          updates
        })
      )
    }
  }
  for (const mutation of args.mutations) {
    if (mutation === args.reparentMutation) {
      continue
    }
    const liveGroups = args.getLiveProjectGroups?.()
    if (
      !isProjectGroupStillInExpectedParent({
        groupId: mutation.groupId,
        expectedParentGroupId: args.expectedParentGroupId,
        ownerHostId: args.ownerHostId,
        liveProjectGroups: liveGroups,
        fallbackProjectGroupById: args.projectGroupById
      })
    ) {
      continue
    }
    const plannedSibling = args.projectGroupById.get(mutation.groupId)
    const liveSibling = liveGroups?.find(
      (candidate) =>
        candidate.id === mutation.groupId &&
        (!args.ownerHostId || getRepoExecutionHostId(candidate) === args.ownerHostId)
    )
    if (
      liveSibling &&
      plannedSibling &&
      (liveSibling.tabOrder !== plannedSibling.tabOrder ||
        (liveSibling.rootProjectOrder ?? null) !== (plannedSibling.rootProjectOrder ?? null))
    ) {
      await abortGroupDropWithRollback({
        appliedRollbacks,
        ownerHostId: args.ownerHostId,
        getLiveProjectGroups: args.getLiveProjectGroups,
        fallbackProjectGroupById: args.projectGroupById,
        onCommitProjectGroupUpdate: args.onCommitProjectGroupUpdate,
        onReconcileHostProjectGroups: args.onReconcileHostProjectGroups,
        onDropFailed: args.onDropFailed
      })
      return { ok: false }
    }
    const siblingRollback = preDropRollbacks.get(mutation.groupId)
    const accepted = await invokeBoolCallback(() =>
      args.onCommitProjectGroupUpdate(mutation.groupId, mutation.updates)
    )
    if (!accepted) {
      await abortGroupDropWithRollback({
        appliedRollbacks,
        ownerHostId: args.ownerHostId,
        getLiveProjectGroups: args.getLiveProjectGroups,
        fallbackProjectGroupById: args.projectGroupById,
        onCommitProjectGroupUpdate: args.onCommitProjectGroupUpdate,
        onReconcileHostProjectGroups: args.onReconcileHostProjectGroups,
        onDropFailed: args.onDropFailed
      })
      return { ok: false }
    }
    if (siblingRollback) {
      appliedRollbacks.push(
        buildAppliedGroupRollbackEntry({
          groupId: mutation.groupId,
          patch: siblingRollback,
          expectedParentGroupId: args.expectedParentGroupId,
          updates: mutation.updates
        })
      )
    }
  }
  return { ok: true, appliedRollbacks }
}
