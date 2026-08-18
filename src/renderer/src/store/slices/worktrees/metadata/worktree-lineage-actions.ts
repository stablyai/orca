import type { WorktreeSlice } from '../../worktree-helpers'
import type { WorktreeSliceGet, WorktreeSliceSet } from '../listing/worktree-slice-types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import type { AppState } from '../../../types'
import {
  applyWorktreeLineageUpdate,
  refreshWorktreeLineageForSettings,
  setWorktreeLineageForRuntime
} from './worktree-lineage-refresh'
import { settingsForWorktreeOwner } from '../listing/worktree-owner-settings'

// Why: this runs inside a catch, so letting the refresh reject would replace the failure it recovers from.
async function refreshWorktreeLineageBestEffort(
  ownerSettings: AppState['settings'],
  set: WorktreeSliceSet
): Promise<void> {
  try {
    await refreshWorktreeLineageForSettings(ownerSettings, set)
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
      const settings = ownerSettings
        ? { ...ownerSettings, activeRuntimeEnvironmentId }
        : ({ activeRuntimeEnvironmentId } as AppState['settings'])
      await refreshWorktreeLineageForSettings(settings, set, {
        reuseRecentCompatibilityFailure: true
      })
    } catch (err) {
      console.error('Failed to fetch worktree lineage:', err)
    }
  }
}

export function createUpdateWorktreeLineage(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeLineage'] {
  return async (worktreeId, args) => {
    // Why: an unresolvable owner route (ambiguous or missing) rejects rather than skipping — this is a
    // user-initiated action, and both callers toast the failure. Don't swallow it into a silent no-op.
    const ownerSettings = settingsForWorktreeOwner(get(), worktreeId)
    try {
      applyWorktreeLineageUpdate(
        set,
        worktreeId,
        await setWorktreeLineageForRuntime(ownerSettings, worktreeId, args)
      )
    } catch (err) {
      console.error('Failed to update worktree lineage:', err)
      await refreshWorktreeLineageBestEffort(ownerSettings, set)
      throw err
    }
  }
}

export function createAssignWorktreeParent(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['assignWorktreeParent'] {
  return async (worktreeId, args) => {
    const ownerSettings = settingsForWorktreeOwner(get(), worktreeId)
    try {
      applyWorktreeLineageUpdate(
        set,
        worktreeId,
        await setWorktreeLineageForRuntime(ownerSettings, worktreeId, args)
      )
    } catch (err) {
      console.error('Failed to assign worktree parent:', err)
      // Unlike the update path this rethrows, so the recovery refresh must not mask the original cause.
      await refreshWorktreeLineageBestEffort(ownerSettings, set)
      throw err
    }
  }
}
