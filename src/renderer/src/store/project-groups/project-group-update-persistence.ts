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

export async function persistProjectGroupUpdate(
  target: RuntimeClientTarget,
  groupId: string,
  updates: Parameters<RepoSlice['updateProjectGroup']>[1]
): Promise<ProjectGroup | null> {
  if (
    updates.rootProjectOrder !== undefined &&
    target.kind === 'environment' &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
    ))
  ) {
    return null
  }
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
  if (!updated || !groupOrderMatchesUpdate(updated, updates)) {
    return null
  }
  return updated
}

export async function persistProjectGroupUpdates(
  target: RuntimeClientTarget,
  mutations: readonly ProjectGroupMutation[]
): Promise<(ProjectGroup | null)[]> {
  if (mutations.length === 0) {
    return []
  }
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
        persistProjectGroupUpdate(target, groupId, updates).catch((err) => {
          console.error('Failed to update project group:', err)
          return null
        })
      )
    )
  }
  if (
    target.kind === 'environment' &&
    mutations.some(({ updates }) => updates.rootProjectOrder !== undefined) &&
    !(await runtimeEnvironmentSupportsCapability(
      target.environmentId,
      PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
    ))
  ) {
    return mutations.map(() => null)
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
    return group && groupOrderMatchesUpdate(group, updates) ? group : null
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
