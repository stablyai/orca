import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { runtimeTargetForOwnerEnvironment } from '../../../../runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import {
  applyWorktreeLineageUpdate,
  refreshWorktreeLineageForTarget,
  setWorktreeLineageForRuntime
} from './worktree-lineage-refresh'
import { hostRouteForWorktreeOwner } from '../listing/worktree-owner-target'
import { callRuntimeRpc } from '../../../../runtime/runtime-rpc-client'
import { toRuntimeWorktreeSelector } from '../../../../runtime/runtime-worktree-selector'
import { mintCrossStoreParentRef } from './cross-store-parent-ref'

// Why: this runs inside a catch, so letting the refresh reject would replace the failure it recovers from.
async function refreshWorktreeLineageBestEffort(
  ownerTarget: RuntimeClientTarget,
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): Promise<void> {
  try {
    await refreshWorktreeLineageForTarget(ownerTarget, set, get)
  } catch (err) {
    console.error('Failed to refresh worktree lineage after a failed write:', err)
  }
}

export function createFetchWorktreeLineage(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['fetchWorktreeLineage'] {
  return async (options) => {
    try {
      // Why: lineage is a focused-host refresh; host-merge so other hosts' fetched lineage is preserved.
      const ownerSettings = get().settings
      const parsedHost = options?.executionHostId
        ? parseExecutionHostId(options.executionHostId)
        : null
      const activeRuntimeEnvironmentId =
        parsedHost?.kind === 'runtime'
          ? parsedHost.environmentId
          : parsedHost || options?.forceLocalOwner
            ? null
            : ownerSettings?.activeRuntimeEnvironmentId
      await refreshWorktreeLineageForTarget(
        runtimeTargetForOwnerEnvironment(activeRuntimeEnvironmentId ?? null),
        set,
        get,
        {
          reuseRecentCompatibilityFailure: true
        }
      )
    } catch (err) {
      console.error('Failed to fetch worktree lineage:', err)
    }
  }
}

export function createUpdateWorktreeLineage(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeLineage'] {
  return async (worktreeId, { executionHostId, ...args }) => {
    // User-initiated unresolved routes must reject so both callers can toast, rather than silently skip.
    const ownerRoute = hostRouteForWorktreeOwner(get(), worktreeId, executionHostId)
    try {
      applyWorktreeLineageUpdate(
        set,
        worktreeId,
        await setWorktreeLineageForRuntime(ownerRoute, worktreeId, args)
      )
    } catch (err) {
      console.error('Failed to update worktree lineage:', err)
      await refreshWorktreeLineageBestEffort(ownerRoute.target, set, get)
      throw err
    }
  }
}

export function createAssignWorktreeParent(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['assignWorktreeParent'] {
  return async (worktreeId, { executionHostId, ...args }) => {
    const ownerRoute = hostRouteForWorktreeOwner(get(), worktreeId, executionHostId)
    try {
      applyWorktreeLineageUpdate(
        set,
        worktreeId,
        await setWorktreeLineageForRuntime(ownerRoute, worktreeId, args)
      )
    } catch (err) {
      console.error('Failed to assign worktree parent:', err)
      // Unlike the update path this rethrows, so the recovery refresh must not mask the original cause.
      await refreshWorktreeLineageBestEffort(ownerRoute.target, set, get)
      throw err
    }
  }
}

/** Set Parent to a workspace on another machine: the parent's store names it, the child's store saves it. */
export function createAssignCrossStoreWorktreeParent(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['assignCrossStoreWorktreeParent'] {
  return async (child, parent) => {
    const ownerRoute = hostRouteForWorktreeOwner(get(), child.id, child.hostId)
    try {
      const crossStoreParent = await mintCrossStoreParentRef(get(), ownerRoute.target, parent, {
        reparent: true
      })
      await callRuntimeRpc(
        ownerRoute.target,
        'worktree.set',
        { worktree: toRuntimeWorktreeSelector(child.id), crossStoreParent },
        { timeoutMs: 15_000 }
      )
    } catch (err) {
      console.error('Failed to assign a parent on another machine:', err)
      throw err
    } finally {
      // The child's store owns its records; its list replaces both same-store and cross-store links.
      await refreshWorktreeLineageBestEffort(ownerRoute.target, set, get)
    }
  }
}
