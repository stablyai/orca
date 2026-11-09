import type { StateCreator } from 'zustand'
import type { AppState } from '../types'
import type { RepoSlice } from '../repos/repo-state'
import type {
  ProjectGroup,
  ProjectGroupMutation
} from '../../../../shared/project/groups/project-group-types'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  catalogOwnsHost,
  resolveProjectGroupOwnerHostId,
  runtimeTargetForProjectGroupOwner
} from './project-group-owner-routing'
import { getRepoExecutionHostId } from '../../../../shared/execution-host/execution-host'
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

type ConfirmedStageEntry = {
  row: ProjectGroup
  revision: number
  commitSeq: number
}

function isSnapshotOlderThanConfirmed(
  existing: ConfirmedStageEntry | undefined,
  row: ProjectGroup,
  commitSeq: number
): boolean {
  if (!existing) {
    return false
  }
  return (
    row.updatedAt < existing.row.updatedAt ||
    (row.updatedAt === existing.row.updatedAt && commitSeq < existing.commitSeq)
  )
}

export function createProjectGroupBatchUpdateAction(
  set: Parameters<StateCreator<AppState>>[0],
  get: Parameters<StateCreator<AppState>>[1]
): RepoSlice['updateProjectGroups'] {
  let nextCommitRevision = 0
  let nextCommitSeq = 0
  const confirmedStageByGroupKey = new Map<string, ConfirmedStageEntry>()
  const successRevisionByGroupKey = new Map<string, number>()

  return async (mutations) => {
    const requestFallbackSeq = ++nextCommitSeq
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
        const finalCommitSeqByGroupId = new Map<string, number>()
        try {
          const groups = await persistProjectGroupUpdates(target, mutations, {
            onParentGroupMoveRejected: () => {
              notifiedSpecificRejection = true
              notifyProjectGroupParentMoveRejected()
            },
            allocateCommitSeq: () => ++nextCommitSeq,
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
            onStageCommitted: (group, commitSeq) => {
              const row = adoptFromEndpoint(target, { kind: 'projectGroup', row: group })
              const groupKey = `${hostKey}:${group.id}`
              const existingConfirmed = confirmedStageByGroupKey.get(groupKey)
              if (isSnapshotOlderThanConfirmed(existingConfirmed, row, commitSeq)) {
                const supersededByPlacementChange =
                  (existingConfirmed?.row.parentGroupId ?? null) !== (row.parentGroupId ?? null) ||
                  existingConfirmed?.row.tabOrder !== row.tabOrder ||
                  (existingConfirmed?.row.rootProjectOrder ?? null) !==
                    (row.rootProjectOrder ?? null) ||
                  existingConfirmed?.row.isPinned !== row.isPinned
                return !supersededByPlacementChange
              }
              const revision = ++nextCommitRevision
              confirmedStageByGroupKey.set(groupKey, { row, revision, commitSeq })
              stagedByGroupId.set(group.id, { row, revision })
              return true
            },
            onFinalCommitSeq: (groupId, commitSeq) => {
              finalCommitSeqByGroupId.set(groupId, commitSeq)
            }
          })
          return groups.map((group, index) => {
            const adoptedRow = group
              ? adoptFromEndpoint(target, { kind: 'projectGroup', row: group })
              : null
            if (group && adoptedRow) {
              const groupKey = `${hostKey}:${group.id}`
              const commitSeq = finalCommitSeqByGroupId.get(group.id) ?? requestFallbackSeq
              const existingConfirmed = confirmedStageByGroupKey.get(groupKey)
              if (isSnapshotOlderThanConfirmed(existingConfirmed, adoptedRow, commitSeq)) {
                return {
                  group: { row: adoptedRow, revision: 0, stale: true },
                  reconciledStage: stagedByGroupId.get(mutations[index].groupId) ?? null,
                  hostKey,
                  ownerHostId: mutations[index].ownerHostId,
                  groupId: mutations[index].groupId
                }
              }
              const groupRevision = ++nextCommitRevision
              confirmedStageByGroupKey.set(groupKey, {
                row: adoptedRow,
                revision: groupRevision,
                commitSeq
              })
              successRevisionByGroupKey.set(groupKey, groupRevision)
              return {
                group: { row: adoptedRow, revision: groupRevision, stale: false },
                reconciledStage: stagedByGroupId.get(mutations[index].groupId) ?? null,
                hostKey,
                ownerHostId: mutations[index].ownerHostId,
                groupId: mutations[index].groupId
              }
            }
            return {
              group: null,
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
          group: { row: ProjectGroup; revision: number; stale: boolean } | null
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
          const groupKey = `${match.hostKey}:${group.id}`
          const latestConfirmed = confirmedStageByGroupKey.get(groupKey)
          const latestConfirmedRevision = latestConfirmed?.revision ?? 0
          if (match.group) {
            if (match.group.stale) {
              return group
            }
            const latestSuccessRevision = successRevisionByGroupKey.get(groupKey) ?? 0
            if (latestSuccessRevision > match.group.revision) {
              return group
            }
            if (latestConfirmed && latestConfirmedRevision > match.group.revision) {
              return mergeReconciledParentStage(match.group.row, latestConfirmed.row)
            }
            return group.updatedAt > match.group.row.updatedAt ? group : match.group.row
          }
          if (!match.reconciledStage) {
            return group
          }
          return latestConfirmedRevision <= match.reconciledStage.revision
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
