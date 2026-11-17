import { getNextRootProjectOrder } from '../../../../shared/sidebar-list/sections/root-project-order'
import type {
  ProjectGroup,
  ProjectGroupMutation
} from '../../../../shared/project/groups/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RepoSlice } from '../repos/repo-state'
import {
  PROJECT_GROUP_UPDATE_MANY_RUNTIME_CAPABILITY,
  PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
} from '../../../../shared/project/groups/project-group-order-capability'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import {
  finalizeSequencedResult,
  splitRemoteParentGroupUpdate,
  verifyProjectGroupMatchesUpdate,
  type PersistProjectGroupUpdateOptions,
  type SequencedProjectGroupResult
} from './project-group-update-verification'

async function persistSingleProjectGroupUpdate(
  target: RuntimeClientTarget,
  groupId: string,
  updates: Parameters<RepoSlice['updateProjectGroup']>[1],
  options?: PersistProjectGroupUpdateOptions
): Promise<SequencedProjectGroupResult> {
  const commitSeq = options?.allocateCommitSeq?.() ?? 0
  const updated =
    target.kind === 'local'
      ? await window.api.projectGroups.update({ groupId, updates })
      : (
          await callRuntimeRpc<{ group: ProjectGroup | null }>(
            target,
            'projectGroup.update',
            { groupId, updates },
            { timeoutMs: 15_000 }
          )
        ).group
  return verifyProjectGroupMatchesUpdate(updated, updates, options)
    ? { row: updated, commitSeq }
    : { row: null, commitSeq }
}

async function persistProjectGroupUpdateSequenced(
  target: RuntimeClientTarget,
  groupId: string,
  updates: Parameters<RepoSlice['updateProjectGroup']>[1],
  options?: PersistProjectGroupUpdateOptions
): Promise<SequencedProjectGroupResult> {
  if (
    updates.rootProjectOrder !== undefined &&
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
    ))
  ) {
    if (updates.parentGroupId !== undefined) {
      options?.onParentGroupMoveRejected?.()
    }
    if (updates.isPinned !== undefined) {
      options?.onPinRejected?.()
    }
    return { row: null, commitSeq: 0 }
  }
  if (target.kind === 'environment') {
    const { parentOnly, remaining } = splitRemoteParentGroupUpdate(updates)
    if (parentOnly && remaining) {
      const parentUpdated = await persistSingleProjectGroupUpdate(
        target,
        groupId,
        parentOnly,
        options
      )
      if (!parentUpdated.row) {
        return { row: null, commitSeq: parentUpdated.commitSeq }
      }
      if (options?.onStageCommitted?.(parentUpdated.row, parentUpdated.commitSeq) === false) {
        return { row: null, commitSeq: parentUpdated.commitSeq }
      }
      return persistSingleProjectGroupUpdate(target, groupId, remaining, options)
    }
  }
  return persistSingleProjectGroupUpdate(target, groupId, updates, options)
}

export async function persistProjectGroupUpdate(
  target: RuntimeClientTarget,
  groupId: string,
  updates: Parameters<RepoSlice['updateProjectGroup']>[1],
  options?: PersistProjectGroupUpdateOptions
): Promise<ProjectGroup | null> {
  const result = await persistProjectGroupUpdateSequenced(target, groupId, updates, options)
  if (result.row) {
    options?.onFinalCommitSeq?.(groupId, result.commitSeq)
  }
  return result.row
}

async function persistProjectGroupUpdatesBatch(
  target: RuntimeClientTarget,
  mutations: readonly ProjectGroupMutation[],
  options?: PersistProjectGroupUpdateOptions
): Promise<SequencedProjectGroupResult[]> {
  if (
    mutations.length === 1 ||
    (target.kind === 'environment' &&
      !(await runtimeEnvironmentSupportsCapability(
        target.environmentId,
        PROJECT_GROUP_UPDATE_MANY_RUNTIME_CAPABILITY
      )))
  ) {
    return Promise.all(
      mutations.map(({ groupId, updates }) =>
        persistProjectGroupUpdateSequenced(target, groupId, updates, options).catch((err) => {
          console.error('Failed to update project group:', err)
          if (updates.isPinned !== undefined) {
            options?.onPinFailed?.()
          }
          return { row: null, commitSeq: 0 }
        })
      )
    )
  }
  const commitSeq = options?.allocateCommitSeq?.() ?? 0
  const updated =
    target.kind === 'local'
      ? await window.api.projectGroups.updateMany({ mutations })
      : (
          await callRuntimeRpc<{ groups: ProjectGroup[] | null }>(
            target,
            'projectGroup.updateMany',
            { mutations },
            { timeoutMs: 15_000 }
          )
        ).groups
  const byId = new Map(updated?.map((group) => [group.id, group]))
  return mutations.map(({ groupId, updates }) => {
    const group = byId.get(groupId)
    return {
      row: verifyProjectGroupMatchesUpdate(group, updates, options) ? group : null,
      commitSeq
    }
  })
}

export async function persistProjectGroupUpdates(
  target: RuntimeClientTarget,
  mutations: readonly ProjectGroupMutation[],
  options?: PersistProjectGroupUpdateOptions
): Promise<(ProjectGroup | null)[]> {
  if (mutations.length === 0) {
    return []
  }
  let notifiedPinRejected = false
  const once = (fn?: () => void, skip?: () => boolean): (() => void) | undefined => {
    let called = false
    return fn
      ? () => {
          if (!called && !skip?.()) {
            called = true
            fn()
          }
        }
      : undefined
  }
  const dedupedOptions: PersistProjectGroupUpdateOptions | undefined = options
    ? {
        ...options,
        onParentGroupMoveRejected: once(options.onParentGroupMoveRejected),
        onPinRejected: once(
          () => {
            notifiedPinRejected = true
            options.onPinRejected?.()
          },
          () => !options.onPinRejected
        ),
        onPinFailed: once(options.onPinFailed, () => notifiedPinRejected)
      }
    : undefined
  if (
    target.kind === 'environment' &&
    mutations.some(({ updates }) => updates.rootProjectOrder !== undefined) &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
    ))
  ) {
    if (mutations.some(({ updates }) => updates.parentGroupId !== undefined)) {
      dedupedOptions?.onParentGroupMoveRejected?.()
    }
    if (mutations.some(({ updates }) => updates.isPinned !== undefined)) {
      dedupedOptions?.onPinRejected?.()
    }
    return mutations.map(() => null)
  }
  const shouldStageRemoteParentFirst =
    target.kind === 'environment' &&
    mutations.some(({ updates }) => updates.parentGroupId !== undefined) &&
    mutations.some(({ updates }) =>
      updates.parentGroupId !== undefined ? Object.keys(updates).length > 1 : true
    )
  if (!shouldStageRemoteParentFirst) {
    const batchResults = await persistProjectGroupUpdatesBatch(target, mutations, dedupedOptions)
    return batchResults.map((result, index) =>
      finalizeSequencedResult(result, mutations[index].groupId, dedupedOptions)
    )
  }
  const parentMutations = mutations.flatMap(({ groupId, updates }) => {
    const { parentOnly } = splitRemoteParentGroupUpdate(updates)
    return parentOnly ? [{ groupId, updates: parentOnly }] : []
  })
  const parentResults = await persistProjectGroupUpdatesBatch(
    target,
    parentMutations,
    dedupedOptions
  )
  let stageSuperseded = false
  for (const result of parentResults) {
    if (result.row && dedupedOptions?.onStageCommitted?.(result.row, result.commitSeq) === false) {
      stageSuperseded = true
    }
  }
  if (stageSuperseded || parentResults.some((result) => result.row === null)) {
    return mutations.map(() => null)
  }
  const parentById = new Map(
    parentResults
      .filter((r): r is { row: ProjectGroup; commitSeq: number } => r.row !== null)
      .map((r) => [r.row.id, r])
  )
  const remainingMutations = mutations.flatMap(({ groupId, updates }) => {
    const { remaining } = splitRemoteParentGroupUpdate(updates)
    return remaining ? [{ groupId, updates: remaining }] : []
  })
  if (remainingMutations.length === 0) {
    return mutations.map(({ groupId }) =>
      finalizeSequencedResult(parentById.get(groupId), groupId, dedupedOptions)
    )
  }
  const remainingResults = await persistProjectGroupUpdatesBatch(
    target,
    remainingMutations,
    dedupedOptions
  )
  let remainingIndex = 0
  return mutations.map(({ groupId, updates }) => {
    if (!splitRemoteParentGroupUpdate(updates).remaining) {
      return finalizeSequencedResult(parentById.get(groupId), groupId, dedupedOptions)
    }
    return finalizeSequencedResult(remainingResults[remainingIndex++], groupId, dedupedOptions)
  })
}

export async function initializeNewRootProjectGroupOrder(
  target: RuntimeClientTarget,
  group: ProjectGroup,
  state: Pick<RepoSlice, 'repos' | 'projectGroups'>
): Promise<ProjectGroup> {
  const rootProjectOrder = !group.parentGroupId
    ? getNextRootProjectOrder(state.repos, state.projectGroups)
    : undefined
  if (rootProjectOrder === undefined) {
    return group
  }
  const groupIds = new Set(state.projectGroups.map((entry) => entry.id))
  let tabOrder = -1000
  for (const existing of state.projectGroups) {
    if (!existing.parentGroupId || !groupIds.has(existing.parentGroupId)) {
      tabOrder = Math.max(tabOrder, existing.tabOrder)
    }
  }
  return (
    (await persistProjectGroupUpdate(target, group.id, {
      rootProjectOrder,
      tabOrder: tabOrder + 1000
    }).catch((err) => {
      console.error('Failed to initialize project group order:', err)
      return null
    })) ?? group
  )
}
