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
  notifyProjectGroupParentMoveRejected,
  notifyProjectGroupPinFailed,
  notifyProjectGroupPinRejected
} from './project-group-mutation-toasts'
import { persistProjectGroupUpdates } from './project-group-update-persistence'

function mergeReconciledParentStage(current: ProjectGroup, staged: ProjectGroup): ProjectGroup {
  if (current.updatedAt > staged.updatedAt) {
    return current
  }
  const next: ProjectGroup = {
    ...current,
    parentGroupId: staged.parentGroupId,
    ...(staged.isPinned !== undefined ? { isPinned: staged.isPinned } : {}),
    updatedAt: Math.max(current.updatedAt, staged.updatedAt)
  }
  if (staged.rootProjectOrder === undefined) {
    const { rootProjectOrder: _removed, ...withoutRootOrder } = next
    return withoutRootOrder
  }
  return { ...next, rootProjectOrder: staged.rootProjectOrder }
}

export function createProjectGroupBatchUpdateAction(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['updateProjectGroups'] {
  let nextCommitRevision = 0
  const confirmedRevisionByGroupKey = new Map<string, number>()

  return async (mutations) => {
    const state = get()
    const batches = new Map<
      string,
      {
        hostKey: string
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
        if (mutations.some((entry) => entry.updates.isPinned !== undefined)) {
          notifyProjectGroupPinFailed()
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
        batch = { hostKey: key, target, mutations: [] }
        batches.set(key, batch)
      }
      batch.mutations.push({ groupId, updates: normalizedUpdates, ownerHostId })
    }
    let notifiedSpecificRejection = false
    let notifiedPinFailure = false
    const results = await Promise.all(
      [...batches.values()].map(async ({ hostKey, target, mutations }) => {
        const stagedByGroupId = new Map<string, { row: ProjectGroup; revision: number }>()
        try {
          const groups = await persistProjectGroupUpdates(target, mutations, {
            onParentGroupMoveRejected: () => {
              notifiedSpecificRejection = true
              notifyProjectGroupParentMoveRejected()
            },
            onPinRejected: () => {
              notifiedSpecificRejection = true
              notifyProjectGroupPinRejected()
            },
            onPinFailed: () => {
              if (!notifiedPinFailure && !notifiedSpecificRejection) {
                notifiedPinFailure = true
                notifyProjectGroupPinFailed()
              }
            },
            onStageCommitted: (group) => {
              const revision = ++nextCommitRevision
              confirmedRevisionByGroupKey.set(`${hostKey}:${group.id}`, revision)
              stagedByGroupId.set(group.id, {
                row: adoptFromEndpoint(target, { kind: 'projectGroup', row: group }),
                revision
              })
            }
          })
          return groups.map((group, index) => {
            if (group) {
              confirmedRevisionByGroupKey.set(`${hostKey}:${group.id}`, ++nextCommitRevision)
            }
            return {
              group: group ? adoptFromEndpoint(target, { kind: 'projectGroup', row: group }) : null,
              reconciledStage: stagedByGroupId.get(mutations[index].groupId) ?? null,
              hostKey,
              ownerHostId: mutations[index].ownerHostId,
              groupId: mutations[index].groupId
            }
          })
        } catch (err) {
          console.error('Failed to update project groups:', err)
          return mutations.map(({ ownerHostId, groupId }) => ({
            group: null,
            reconciledStage: stagedByGroupId.get(groupId) ?? null,
            hostKey,
            ownerHostId,
            groupId
          }))
        }
      })
    )
    const updatedById = new Map<
      string,
      Map<
        string | null,
        {
          group: ProjectGroup | null
          reconciledStage: { row: ProjectGroup; revision: number } | null
          hostKey: string
        }
      >
    >()
    let saved = true
    for (const { group, reconciledStage, hostKey, groupId, ownerHostId } of results.flat()) {
      if (!group) {
        saved = false
      }
      if (!group && !reconciledStage) {
        continue
      }
      let owners = updatedById.get(groupId)
      if (!owners) {
        owners = new Map()
        updatedById.set(groupId, owners)
      }
      owners.set(ownerHostId, { group, reconciledStage, hostKey })
    }
    if (updatedById.size > 0) {
      set((s) => ({
        projectGroups: s.projectGroups.map((group) => {
          const owners = updatedById.get(group.id)
          const hostId = getRepoExecutionHostId(group)
          const match =
            owners?.get(hostId) ??
            (catalogOwnsHost('local', hostId) ? owners?.get('local') : undefined) ??
            owners?.get(null)
          if (!match) {
            return group
          }
          if (match.group) {
            return match.group
          }
          if (!match.reconciledStage) {
            return group
          }
          const latestRevision =
            confirmedRevisionByGroupKey.get(`${match.hostKey}:${group.id}`) ?? 0
          return latestRevision <= match.reconciledStage.revision
            ? mergeReconciledParentStage(group, match.reconciledStage.row)
            : group
        }),
        folderWorkspacePathStatuses: {}
      }))
    }
    if (!saved && !notifiedSpecificRejection) {
      if (mutations.some(({ updates }) => updates.parentGroupId !== undefined)) {
        notifyProjectGroupMoveFailed()
      }
      if (!notifiedPinFailure && mutations.some(({ updates }) => updates.isPinned !== undefined)) {
        notifyProjectGroupPinFailed()
      }
    }
    return saved
  }
}
