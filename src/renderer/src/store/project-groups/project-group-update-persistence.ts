import { getNextRootProjectOrder } from '../../../../shared/root-project-order'
import type { ProjectGroup, ProjectGroupMutation } from '../../../../shared/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RepoSlice } from '../repos/repo-state'
import {
  PROJECT_GROUP_UPDATE_MANY_RUNTIME_CAPABILITY,
  PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
} from '../../../../shared/project-group-order-capability'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

function groupOrderMatchesUpdate(
  group: ProjectGroup,
  updates: ProjectGroupMutation['updates']
): boolean {
  return (
    (updates.rootProjectOrder === undefined ||
      (group.rootProjectOrder ?? null) === updates.rootProjectOrder) &&
    (updates.tabOrder === undefined || group.tabOrder === updates.tabOrder)
  )
}

type PersistProjectGroupUpdateOptions = {
  onParentGroupMoveRejected?: () => void
  onPinRejected?: () => void
  onStageCommitted?: (group: ProjectGroup) => void
}

function verifyProjectGroupMatchesUpdate(
  group: ProjectGroup,
  updates: ProjectGroupMutation['updates'],
  options?: PersistProjectGroupUpdateOptions
): boolean {
  if (
    updates.parentGroupId !== undefined &&
    (group.parentGroupId ?? null) !== updates.parentGroupId
  ) {
    options?.onParentGroupMoveRejected?.()
    return false
  }
  if (updates.isPinned !== undefined && group.isPinned !== updates.isPinned) {
    options?.onPinRejected?.()
    return false
  }
  return groupOrderMatchesUpdate(group, updates)
}

function splitRemoteParentGroupUpdate(updates: ProjectGroupMutation['updates']): {
  parentOnly: ProjectGroupMutation['updates'] | null
  remaining: ProjectGroupMutation['updates'] | null
} {
  if (updates.parentGroupId === undefined) {
    return { parentOnly: null, remaining: updates }
  }
  const { parentGroupId, ...rest } = updates
  return {
    parentOnly: { parentGroupId },
    remaining: Object.keys(rest).length > 0 ? rest : null
  }
}

async function persistSingleProjectGroupUpdate(
  target: RuntimeClientTarget,
  groupId: string,
  updates: Parameters<RepoSlice['updateProjectGroup']>[1],
  options?: PersistProjectGroupUpdateOptions
): Promise<ProjectGroup | null> {
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
  if (!updated || !verifyProjectGroupMatchesUpdate(updated, updates, options)) {
    return null
  }
  return updated
}

export async function persistProjectGroupUpdate(
  target: RuntimeClientTarget,
  groupId: string,
  updates: Parameters<RepoSlice['updateProjectGroup']>[1],
  options?: PersistProjectGroupUpdateOptions
): Promise<ProjectGroup | null> {
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
    return null
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
      if (!parentUpdated) {
        return null
      }
      options?.onStageCommitted?.(parentUpdated)
      return persistSingleProjectGroupUpdate(target, groupId, remaining, options)
    }
  }
  return persistSingleProjectGroupUpdate(target, groupId, updates, options)
}

async function persistProjectGroupUpdatesBatch(
  target: RuntimeClientTarget,
  mutations: readonly ProjectGroupMutation[],
  options?: PersistProjectGroupUpdateOptions
): Promise<(ProjectGroup | null)[]> {
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
        persistProjectGroupUpdate(target, groupId, updates, options).catch((err) => {
          console.error('Failed to update project group:', err)
          return null
        })
      )
    )
  }
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
    return group && verifyProjectGroupMatchesUpdate(group, updates, options) ? group : null
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
  let notifiedParentMoveRejected = false
  let notifiedPinRejected = false
  const dedupedOptions: PersistProjectGroupUpdateOptions | undefined = options
    ? {
        onParentGroupMoveRejected: options.onParentGroupMoveRejected
          ? () => {
              if (!notifiedParentMoveRejected) {
                notifiedParentMoveRejected = true
                options.onParentGroupMoveRejected?.()
              }
            }
          : undefined,
        onPinRejected: options.onPinRejected
          ? () => {
              if (!notifiedPinRejected) {
                notifiedPinRejected = true
                options.onPinRejected?.()
              }
            }
          : undefined,
        onStageCommitted: options.onStageCommitted
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
  if (shouldStageRemoteParentFirst) {
    const parentMutations = mutations.flatMap(({ groupId, updates }) => {
      const { parentOnly } = splitRemoteParentGroupUpdate(updates)
      return parentOnly ? [{ groupId, updates: parentOnly }] : []
    })
    const parentResults = await persistProjectGroupUpdatesBatch(
      target,
      parentMutations,
      dedupedOptions
    )
    for (const group of parentResults) {
      if (group) {
        dedupedOptions?.onStageCommitted?.(group)
      }
    }
    if (parentResults.some((group) => group === null)) {
      return mutations.map(() => null)
    }
    const parentById = new Map(
      parentResults
        .filter((group): group is ProjectGroup => group !== null)
        .map((group) => [group.id, group])
    )
    const remainingMutations = mutations.flatMap(({ groupId, updates }) => {
      const { remaining } = splitRemoteParentGroupUpdate(updates)
      return remaining ? [{ groupId, updates: remaining }] : []
    })
    if (remainingMutations.length === 0) {
      return mutations.map(({ groupId }) => parentById.get(groupId) ?? null)
    }
    const remainingResults = await persistProjectGroupUpdatesBatch(
      target,
      remainingMutations,
      dedupedOptions
    )
    let remainingIndex = 0
    return mutations.map(({ groupId, updates }) => {
      const { remaining } = splitRemoteParentGroupUpdate(updates)
      if (!remaining) {
        return parentById.get(groupId) ?? null
      }
      const next = remainingResults[remainingIndex]
      remainingIndex += 1
      return next ?? null
    })
  }
  return persistProjectGroupUpdatesBatch(target, mutations, dedupedOptions)
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
