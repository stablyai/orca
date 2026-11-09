import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import type { ProjectGroup, ProjectGroupMutation } from '../../../../shared/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import {
  catalogOwnsHost,
  resolveProjectGroupOwnerHostId,
  runtimeTargetForProjectGroupOwner
} from './project-group-owner-routing'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import { getRuntimeTargetHostId } from '../../runtime/rpc/targets/runtime-client-target'
import { adoptFromEndpoint } from '../host-catalog/endpoint-catalog-adoption'
import {
  notifyProjectGroupMoveFailed,
  notifyProjectGroupParentMoveRejected
} from './project-group-mutation-toasts'
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
        mutations: (ProjectGroupMutation & { ownerHostId: string | null })[]
      }
    >()
    for (const { groupId, updates, hostId } of mutations) {
      const target = runtimeTargetForProjectGroupOwner(state, groupId, hostId)
      if (!target) {
        if (mutations.some((entry) => entry.updates.parentGroupId !== undefined)) {
          notifyProjectGroupMoveFailed()
        }
        return false
      }
      const ownerHostId = resolveProjectGroupOwnerHostId(state, groupId, hostId)
      const normalizedUpdates =
        updates.parentGroupId === undefined
          ? updates
          : { ...updates, parentGroupId: updates.parentGroupId?.trim() || null }
      const key = getRuntimeTargetHostId(target)
      let batch = batches.get(key)
      if (!batch) {
        batch = { target, mutations: [] }
        batches.set(key, batch)
      }
      batch.mutations.push({ groupId, updates: normalizedUpdates, ownerHostId })
    }
    let notifiedSpecificRejection = false
    const results = await Promise.all(
      [...batches.values()].map(async ({ target, mutations }) => {
        const stagedByGroupId = new Map<string, ProjectGroup>()
        try {
          const groups = await persistProjectGroupUpdates(target, mutations, {
            onParentGroupMoveRejected: () => {
              notifiedSpecificRejection = true
              notifyProjectGroupParentMoveRejected()
            },
            onStageCommitted: (group) => {
              stagedByGroupId.set(
                group.id,
                adoptFromEndpoint(target, { kind: 'projectGroup', row: group })
              )
            }
          })
          return groups.map((group, index) => ({
            group: group ? adoptFromEndpoint(target, { kind: 'projectGroup', row: group }) : null,
            reconciledGroup: stagedByGroupId.get(mutations[index].groupId) ?? null,
            ownerHostId: mutations[index].ownerHostId,
            groupId: mutations[index].groupId
          }))
        } catch (err) {
          console.error('Failed to update project groups:', err)
          return mutations.map(({ ownerHostId, groupId }) => ({
            group: null,
            reconciledGroup: stagedByGroupId.get(groupId) ?? null,
            ownerHostId,
            groupId
          }))
        }
      })
    )
    const updatedById = new Map<string, Map<string | null, ProjectGroup>>()
    let saved = true
    for (const { group, reconciledGroup, groupId, ownerHostId } of results.flat()) {
      const effectiveGroup = group ?? reconciledGroup
      if (!group) {
        saved = false
      }
      if (!effectiveGroup) {
        continue
      }
      let owners = updatedById.get(groupId)
      if (!owners) {
        owners = new Map()
        updatedById.set(groupId, owners)
      }
      owners.set(ownerHostId, effectiveGroup)
    }
    if (updatedById.size > 0) {
      set((s) => ({
        projectGroups: s.projectGroups.map((group) => {
          const owners = updatedById.get(group.id)
          const hostId = getRepoExecutionHostId(group)
          return (
            owners?.get(hostId) ??
            (catalogOwnsHost('local', hostId) ? owners?.get('local') : undefined) ??
            owners?.get(null) ??
            group
          )
        }),
        folderWorkspacePathStatuses: {}
      }))
    }
    if (!saved && !notifiedSpecificRejection) {
      if (mutations.some(({ updates }) => updates.parentGroupId !== undefined)) {
        notifyProjectGroupMoveFailed()
      }
    }
    return saved
  }
}
