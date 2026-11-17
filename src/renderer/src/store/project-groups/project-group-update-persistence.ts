import { getNextRootProjectOrder } from '../../../../shared/sidebar-list/sections/root-project-order'
import type {
  ProjectGroup,
  ProjectGroupMutation,
  ProjectGroupUpdate
} from '../../../../shared/project/groups/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { RuntimeCapability } from '../../../../shared/remote-runtime/protocol/protocol-version'
import type { RepoSlice } from '../repos/repo-state'
import {
  PROJECT_GROUP_UPDATE_MANY_RUNTIME_CAPABILITY,
  PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY
} from '../../../../shared/project/groups/project-group-order-capability'
import { PROJECT_GROUP_NESTING_RUNTIME_CAPABILITY } from '../../../../shared/project/groups/project-group-nesting-capability'
import {
  runtimeEnvironmentSupportsCapabilities,
  runtimeEnvironmentSupportsCapability
} from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

// Why: older hosts drop fields they don't know and still answer, so only the echoed row proves the update landed.
function groupPlacementMatchesUpdate(group: ProjectGroup, updates: ProjectGroupUpdate): boolean {
  return (
    (updates.rootProjectOrder === undefined ||
      (group.rootProjectOrder ?? null) === updates.rootProjectOrder) &&
    (updates.tabOrder === undefined || group.tabOrder === updates.tabOrder) &&
    (updates.parentGroupId === undefined || (group.parentGroupId ?? null) === updates.parentGroupId)
  )
}

async function targetSupportsUpdates(
  target: RuntimeClientTarget,
  updates: readonly ProjectGroupUpdate[]
): Promise<boolean> {
  if (target.kind !== 'environment') {
    return true
  }
  const capabilities: RuntimeCapability[] = []
  if (updates.some((update) => update.rootProjectOrder !== undefined)) {
    capabilities.push(PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY)
  }
  if (updates.some((update) => update.parentGroupId !== undefined)) {
    capabilities.push(PROJECT_GROUP_NESTING_RUNTIME_CAPABILITY)
  }
  return (
    capabilities.length === 0 ||
    (await runtimeEnvironmentSupportsCapabilities(target.environmentId, capabilities)).every(
      Boolean
    )
  )
}

export async function persistProjectGroupUpdate(
  target: RuntimeClientTarget,
  groupId: string,
  updates: ProjectGroupUpdate
): Promise<ProjectGroup | null> {
  if (!(await targetSupportsUpdates(target, [updates]))) {
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
  if (!updated || !groupPlacementMatchesUpdate(updated, updates)) {
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
    !(await targetSupportsUpdates(
      target,
      mutations.map(({ updates }) => updates)
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
    return group && groupPlacementMatchesUpdate(group, updates) ? group : null
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
