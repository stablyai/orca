import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import type { ProjectGroup, ProjectGroupMutation } from '../../../../shared/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { catalogOwnsHost, resolveProjectGroupMutationTarget } from './project-group-owner-routing'
import { getRepoExecutionHostId, type ExecutionHostId } from '../../../../shared/execution-host'
import { getRuntimeTargetHostId } from '../../runtime/rpc/targets/runtime-client-target'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import { persistProjectGroupUpdates } from './project-group-update-persistence'

export function createProjectGroupBatchUpdateAction(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['updateProjectGroups'] {
  return async (mutations) => {
    const state = get()
    const batches = new Map<
      string,
      {
        target: RuntimeClientTarget
        mutations: (ProjectGroupMutation & { ownerHostId: ExecutionHostId })[]
      }
    >()
    for (const { groupId, updates, hostId } of mutations) {
      const route = resolveProjectGroupMutationTarget(state, groupId, hostId)
      if (!route) {
        return false
      }
      const { target, ownerHostId } = route
      const key = getRuntimeTargetHostId(target)
      let batch = batches.get(key)
      if (!batch) {
        batch = { target, mutations: [] }
        batches.set(key, batch)
      }
      batch.mutations.push({ groupId, updates, ownerHostId })
    }
    const results = await Promise.all(
      [...batches.values()].map(async ({ target, mutations }) => {
        try {
          const groups = await persistProjectGroupUpdates(target, mutations)
          return groups.map((group, index) => ({
            group: group ? adoptFromEndpoint(target, { kind: 'projectGroup', row: group }) : null,
            ownerHostId: mutations[index].ownerHostId,
            groupId: mutations[index].groupId
          }))
        } catch (err) {
          console.error('Failed to update project groups:', err)
          return mutations.map(({ ownerHostId, groupId }) => ({
            group: null,
            ownerHostId,
            groupId
          }))
        }
      })
    )
    const updatedById = new Map<string, Map<ExecutionHostId, ProjectGroup>>()
    let saved = true
    for (const { group, groupId, ownerHostId } of results.flat()) {
      if (!group) {
        saved = false
        continue
      }
      let owners = updatedById.get(groupId)
      if (!owners) {
        owners = new Map()
        updatedById.set(groupId, owners)
      }
      owners.set(ownerHostId, group)
    }
    if (updatedById.size > 0) {
      set((s) => ({
        projectGroups: s.projectGroups.map((group) => {
          const owners = updatedById.get(group.id)
          const hostId = getRepoExecutionHostId(group)
          return (
            owners?.get(hostId) ??
            (catalogOwnsHost('local', hostId) ? owners?.get('local') : undefined) ??
            group
          )
        }),
        folderWorkspacePathStatuses: {}
      }))
    }
    return saved
  }
}
