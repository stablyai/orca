import { getNextRootProjectOrder } from '../../../../shared/root-project-order'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { RepoSlice } from '../repos/repo-state'
import { PROJECT_ROOT_ORDER_RUNTIME_CAPABILITY } from '../../../../shared/project-group-order-capability'
import { runtimeEnvironmentSupportsCapability } from '@/runtime/rpc/compatibility/runtime-capability-proof'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'

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
  if (
    !updated ||
    (updates.rootProjectOrder !== undefined &&
      (updated.rootProjectOrder ?? null) !== updates.rootProjectOrder) ||
    (updates.tabOrder !== undefined && updated.tabOrder !== updates.tabOrder)
  ) {
    return null
  }
  return updated
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
    }).catch(() => null)) ?? group
  )
}
