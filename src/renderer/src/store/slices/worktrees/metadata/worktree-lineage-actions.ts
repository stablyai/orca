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
import { getActiveRuntimeTarget } from '../../../../runtime/runtime-rpc-client'
import { captureFolderParentContext } from '@/components/sidebar/folder-workspace-parent-candidates'
import { withWorktreeParentMutation } from './worktree-parent-mutation-guard'

// Why: this runs inside a catch, so letting the refresh reject would replace the failure it recovers from.
async function refreshWorktreeLineageBestEffort(
  ownerSettings: AppState['settings'],
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): Promise<void> {
  try {
    await refreshWorktreeLineageForSettings(ownerSettings, set, get)
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
      await refreshWorktreeLineageForSettings(settings, set, get, {
        reuseRecentCompatibilityFailure: true
      })
    } catch (err) {
      console.error('Failed to fetch worktree lineage:', err)
    }
  }
}

function createGuardedParentMutation(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet,
  errorLabel: string
): WorktreeSlice['updateWorktreeLineage'] {
  return async (worktreeId, args) => {
    const state = get()
    const ownerSettings = settingsForWorktreeOwner(state, worktreeId)
    const target = getActiveRuntimeTarget(ownerSettings)
    const contexts = Object.values(state.worktreesByRepo)
      .flat()
      .filter((row) => row.id === worktreeId)
      .map((row) => captureFolderParentContext(state, row))
      .filter(
        (context) =>
          context &&
          context.runtimeEnvironmentId ===
            (target.kind === 'environment' ? target.environmentId : null)
      )
    if (contexts.length > 1) {
      throw new Error('Workspace identity is ambiguous.')
    }
    const key = contexts[0]?.mutationKey ?? JSON.stringify([target, worktreeId])
    return withWorktreeParentMutation(key, async () => {
      try {
        applyWorktreeLineageUpdate(
          set,
          worktreeId,
          await setWorktreeLineageForRuntime(ownerSettings, worktreeId, args)
        )
      } catch (error) {
        console.error(errorLabel, error)
        await refreshWorktreeLineageBestEffort(ownerSettings, set, get)
        throw error
      }
    })
  }
}

export function createUpdateWorktreeLineage(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['updateWorktreeLineage'] {
  return createGuardedParentMutation(set, get, 'Failed to update worktree lineage:')
}

export function createAssignWorktreeParent(
  set: WorktreeSliceSet,
  get: WorktreeSliceGet
): WorktreeSlice['assignWorktreeParent'] {
  return createGuardedParentMutation(set, get, 'Failed to assign worktree parent:')
}
