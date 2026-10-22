import { ORCA_SIDEBAR_INPUTS_IS_MAIN } from '../../../../../../shared/sidebar-inputs-switch'
import { beginEnclosingWorktreeRemoval } from '@/store/active-worktree-deselection-intent'
import type { WorktreePurgeTarget, WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import type { DetectedWorktreeListResult } from '../../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { toRuntimeExecutionHostId } from '../../../../../../shared/execution-host'
import { getRepoIdFromWorktreeId } from '../../worktree-helpers'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import {
  dropRuntimeHostedCatalogRows,
  dropWorktreeRowsForRemovedRuntimeEnvironments,
  isRemovedRuntimeHostId
} from '../../stale-runtime-host-rows'
import { buildFullWorktreePurgeState } from './worktree-purge-state'
import { removeWorktreeVisitEntriesForTargets } from '@/lib/worktree-visit-recency'
import { settleAttentionRemovedBy } from '../../workspace-attention/attention-removal-follow-up'
import { flushRetiredHostEdits } from './removed-workspace-unsaved-files'
import { selectProjectGroups } from '../../../project-catalog-selectors'
import { partitionCatalogByRemovedHosts } from './removed-host-catalog-partition'

export function createPurgeStaleRuntimeHostState(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['purgeStaleRuntimeHostState'] {
  const purge: WorktreeSlice['purgeStaleRuntimeHostState'] = (removedEnvironmentIds) => {
    const removed = new Set(removedEnvironmentIds)
    if (removed.size === 0) {
      return
    }
    // Why before the purge: delayed views must commit text it may offer back.
    flushRetiredHostEdits(get(), removed)
    // Why no flag settle: the purged host's rows are dropped here, and a surviving same-id row on
    // another host must keep its own flag (a marker-less Mark as unread included).
    settleAttentionRemovedBy(
      set,
      get,
      () =>
        set((s) => {
          const {
            repoIdsWithRemovedOwners,
            survivingRepoIds,
            repoIdsWithSurvivingOwners,
            survivingRepos,
            reposChanged,
            survivingSetups,
            setupsChanged,
            survivingGroups: projectGroups
          } = partitionCatalogByRemovedHosts(s, removed)
          const folderWorkspaces = dropRuntimeHostedCatalogRows(s.folderWorkspaces, removed)
          const groupsChanged =
            projectGroups !== selectProjectGroups(s) || folderWorkspaces !== s.folderWorkspaces
          const detectedRows: Record<string, DetectedWorktreeListResult['worktrees']> =
            Object.fromEntries(
              Object.entries(s.detectedWorktreesByRepo).map(([repoId, result]) => [
                repoId,
                result.worktrees
              ])
            )
          // Why: repo/setup catalogs can lag session hydration, so hosted worktree rows are ownership evidence during that gap.
          const recordWorktreeOwners = (
            rowsByRepo: Record<
              string,
              readonly { hostId?: ExecutionHostId; runtimeOwnerEnvironmentId?: string }[]
            >
          ): void => {
            for (const [repoId, rows] of Object.entries(rowsByRepo)) {
              for (const row of rows) {
                if (!row.hostId && !row.runtimeOwnerEnvironmentId) {
                  continue
                }
                const ownerWasRemoved = row.runtimeOwnerEnvironmentId
                  ? removed.has(row.runtimeOwnerEnvironmentId)
                  : isRemovedRuntimeHostId(row.hostId, removed)
                const ownerSet = ownerWasRemoved
                  ? repoIdsWithRemovedOwners
                  : repoIdsWithSurvivingOwners
                ownerSet.add(repoId)
              }
            }
          }
          recordWorktreeOwners(s.worktreesByRepo)
          recordWorktreeOwners(detectedRows)

          const removedWorktreeTargets: WorktreePurgeTarget[] = []
          const seenRemovedWorktreeTargets = new Set<string>()
          const sessionWorktreeIdsOwnedByRemovedHosts = new Set<string>()
          let survivingRestoredSessionOwners = s.restoredRuntimeHostIdByWorkspaceSessionKey
          for (const [workspaceKey, hostId] of Object.entries(
            s.restoredRuntimeHostIdByWorkspaceSessionKey
          )) {
            const scope = parseWorkspaceKey(workspaceKey)
            if (scope?.type === 'folder') {
              continue
            }
            const worktreeId = scope?.type === 'worktree' ? scope.worktreeId : workspaceKey
            const repoId = getRepoIdFromWorktreeId(worktreeId)
            if (!isRemovedRuntimeHostId(hostId, removed)) {
              // Why: restored sessions can be the only surviving-owner evidence before catalogs load.
              repoIdsWithSurvivingOwners.add(repoId)
              continue
            }
            sessionWorktreeIdsOwnedByRemovedHosts.add(worktreeId)
            // Restored session ownership is authoritative even before catalog rows hydrate.
            const identity = `${hostId}\u0000${worktreeId}`
            if (!seenRemovedWorktreeTargets.has(identity)) {
              seenRemovedWorktreeTargets.add(identity)
              removedWorktreeTargets.push({ id: worktreeId, hostId })
            }
            repoIdsWithRemovedOwners.add(repoId)
            if (survivingRestoredSessionOwners === s.restoredRuntimeHostIdByWorkspaceSessionKey) {
              survivingRestoredSessionOwners = { ...survivingRestoredSessionOwners }
            }
            delete survivingRestoredSessionOwners[workspaceKey]
          }

          // Why: legacy rows predate host stamps; every owner record must agree no host survives before an unhosted row is retired.
          const repoIdsWithoutSurvivingOwners = new Set(repoIdsWithRemovedOwners)
          for (const repoId of repoIdsWithSurvivingOwners) {
            repoIdsWithoutSurvivingOwners.delete(repoId)
          }

          // Preserve host ownership for recency teardown. The other bulk maps are
          // keyed by raw worktree id, but a host-qualified visit must not be
          // removed when an id twin survives on another host.
          const addRemovedWorktreeTarget = (
            worktreeId: string,
            hostId: ExecutionHostId | undefined
          ): void => {
            const identity = `${hostId ?? ''}\u0000${worktreeId}`
            if (seenRemovedWorktreeTargets.has(identity)) {
              return
            }
            seenRemovedWorktreeTargets.add(identity)
            removedWorktreeTargets.push(hostId ? { id: worktreeId, hostId } : { id: worktreeId })
          }
          const worktreeDrop = dropWorktreeRowsForRemovedRuntimeEnvironments(
            s.worktreesByRepo,
            removed,
            repoIdsWithoutSurvivingOwners
          )
          const detectedDrop = dropWorktreeRowsForRemovedRuntimeEnvironments(
            detectedRows,
            removed,
            repoIdsWithoutSurvivingOwners
          )

          const worktreesChanged = worktreeDrop.rowsByRepo !== s.worktreesByRepo
          const detectedChanged = detectedDrop.rowsByRepo !== detectedRows

          const removedRows = [...worktreeDrop.removedRows, ...detectedDrop.removedRows]
          for (const row of removedRows) {
            // A row's execution host is the recency owner. Runtime ownership
            // is the only host evidence available for legacy rows without it.
            addRemovedWorktreeTarget(
              row.id,
              row.hostId ??
                (row.runtimeOwnerEnvironmentId
                  ? toRuntimeExecutionHostId(row.runtimeOwnerEnvironmentId)
                  : undefined)
            )
          }
          const removedWorktreeIds = new Set([
            ...removedRows.map((row) => row.id),
            ...sessionWorktreeIdsOwnedByRemovedHosts
          ])
          // Why: terminal tabs hydrate before worktree metadata, so session-only ids for owner-less repos still need purging.
          if (repoIdsWithoutSurvivingOwners.size > 0) {
            for (const worktreeId of Object.keys(s.tabsByWorktree)) {
              const scope = parseWorkspaceKey(worktreeId)
              const rawWorktreeId = scope?.type === 'worktree' ? scope.worktreeId : worktreeId
              if (
                scope?.type !== 'folder' &&
                repoIdsWithoutSurvivingOwners.has(getRepoIdFromWorktreeId(rawWorktreeId))
              ) {
                removedWorktreeIds.add(rawWorktreeId)
              }
            }
          }
          // Why: bare-id state follows an exact survivor unless the restored-session partition proves it belonged to the removed host.
          for (const rows of [
            ...Object.values(worktreeDrop.rowsByRepo),
            ...Object.values(detectedDrop.rowsByRepo)
          ]) {
            for (const row of rows) {
              if (!sessionWorktreeIdsOwnedByRemovedHosts.has(row.id)) {
                removedWorktreeIds.delete(row.id)
              }
            }
          }
          const purgeTargets = [...removedWorktreeIds].flatMap((worktreeId) => {
            const targets = removedWorktreeTargets.filter((target) => target.id === worktreeId)
            return targets.length > 0 ? targets : [{ id: worktreeId }]
          })
          // Why full: survivor ids were dropped above unless the session partition proves the bare-id state is the removed host's.
          const purgeState =
            purgeTargets.length > 0 ? buildFullWorktreePurgeState(s, purgeTargets) : {}
          const visitPurgeTargets = [
            ...removedWorktreeTargets,
            ...purgeTargets.filter(
              (target) => !removedWorktreeTargets.some((candidate) => candidate.id === target.id)
            )
          ]
          const nextLastVisitedAtByWorktreeId = removeWorktreeVisitEntriesForTargets(
            s.lastVisitedAtByWorktreeId,
            visitPurgeTargets
          )
          if (nextLastVisitedAtByWorktreeId !== s.lastVisitedAtByWorktreeId) {
            purgeState.lastVisitedAtByWorktreeId = nextLastVisitedAtByWorktreeId
          }

          const restoredSessionOwnersChanged =
            survivingRestoredSessionOwners !== s.restoredRuntimeHostIdByWorkspaceSessionKey
          let survivingVisibilityDefaults = s.worktreeVisibilityDefaultsByHost
          for (const environmentId of removed) {
            const hostId = toRuntimeExecutionHostId(environmentId)
            if (hostId in survivingVisibilityDefaults) {
              if (survivingVisibilityDefaults === s.worktreeVisibilityDefaultsByHost) {
                survivingVisibilityDefaults = { ...survivingVisibilityDefaults }
              }
              delete survivingVisibilityDefaults[hostId]
            }
          }
          const visibilityDefaultsChanged =
            survivingVisibilityDefaults !== s.worktreeVisibilityDefaultsByHost
          const visibilitySupportChanged = removed.has(
            s.worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId ?? ''
          )
          const visibilitySourceSupportChanged = removed.has(
            s.worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId ?? ''
          )
          if (
            !reposChanged &&
            !setupsChanged &&
            !groupsChanged &&
            !worktreesChanged &&
            !detectedChanged &&
            !restoredSessionOwnersChanged &&
            !visibilityDefaultsChanged &&
            !visibilitySupportChanged &&
            !visibilitySourceSupportChanged &&
            removedWorktreeIds.size === 0
          ) {
            return s
          }

          const detectedWorktreesByRepo = detectedChanged
            ? Object.fromEntries(
                Object.entries(s.detectedWorktreesByRepo).map(([repoId, result]) => [
                  repoId,
                  { ...result, worktrees: detectedDrop.rowsByRepo[repoId] }
                ])
              )
            : s.detectedWorktreesByRepo

          const rowsChanged = worktreesChanged || detectedChanged
          return {
            ...purgeState,
            // Switch point: main's catalog drops the removed hosts' rows itself.
            ...(ORCA_SIDEBAR_INPUTS_IS_MAIN
              ? { folderWorkspaces }
              : {
                  ...(reposChanged ? { repos: survivingRepos } : {}),
                  ...(setupsChanged ? { projectHostSetups: survivingSetups } : {}),
                  ...(groupsChanged ? { projectGroups, folderWorkspaces } : {})
                }),
            ...(worktreesChanged ? { worktreesByRepo: worktreeDrop.rowsByRepo } : {}),
            ...(detectedChanged ? { detectedWorktreesByRepo } : {}),
            ...(restoredSessionOwnersChanged
              ? { restoredRuntimeHostIdByWorkspaceSessionKey: survivingRestoredSessionOwners }
              : {}),
            ...(visibilityDefaultsChanged
              ? { worktreeVisibilityDefaultsByHost: survivingVisibilityDefaults }
              : {}),
            ...(visibilitySupportChanged
              ? { worktreeVisibilityDefaultsSupportedRuntimeEnvironmentId: null }
              : {}),
            ...(visibilitySourceSupportChanged
              ? { worktreeVisibilitySourceDefaultsSupportedRuntimeEnvironmentId: null }
              : {}),
            ...(rowsChanged ? { sortEpoch: s.sortEpoch + 1 } : {}),
            // Why: mirror validateRepoScopedUi so a filtered/active sidebar can't reference a purged repo id.
            ...(reposChanged
              ? {
                  activeRepoId:
                    s.activeRepoId && survivingRepoIds.has(s.activeRepoId) ? s.activeRepoId : null,
                  filterRepoIds: s.filterRepoIds.filter((repoId) => survivingRepoIds.has(repoId))
                }
              : {})
          }
        }),
      { settleFlags: false }
    )
  }
  return (ids) => {
    const removed = [...ids]
    const finishRemovals = removed.map((id) =>
      beginEnclosingWorktreeRemoval({ hostId: toRuntimeExecutionHostId(id) })
    )
    try {
      purge(removed)
    } finally {
      finishRemovals.forEach((finish) => finish())
    }
  }
}
