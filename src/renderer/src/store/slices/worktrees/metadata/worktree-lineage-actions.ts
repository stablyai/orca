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
    const ownerSettings = settingsForWorktreeOwner(get(), worktreeId)
    try {
      applyWorktreeLineageUpdate(
        set,
        worktreeId,
        await setWorktreeLineageForRuntime(ownerSettings, worktreeId, args)
      )
    } catch (err) {
      console.error('Failed to update worktree lineage:', err)
      await refreshWorktreeLineageForSettings(ownerSettings, set)
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
      await refreshWorktreeLineageForSettings(ownerSettings, set)
      throw err
    }
  }
}
