import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import { worktreeOwnerRowsTokenOf } from '@/lib/workspace/ownership/worktree-owner-rows-token'
import { selectWorktreesByRepo } from '@/store/workspaces/catalog/workspace-record-fields'
import { structuredAgentSessionOwnerForTab } from '@/runtime/native-chat/session-ownership/structured-agent-session-owner'
import type { StructuredTab } from './structured-agent-session-tabs'

export const ownerInputs: readonly (keyof WorktreeRuntimeOwnerState)[] = [
  'repos',
  'settings',
  'worktreesByRepo',
  'detectedWorktreesByRepo',
  'folderWorkspaces',
  'projectGroups',
  'restoredRuntimeHostIdByWorkspaceSessionKey',
  'activeWorktreeId',
  'activeWorkspaceExecutionHostId',
  'runtimeEnvironments',
  'runtimeEnvironmentCatalogHydrated',
  'removedRuntimeEnvironmentIds'
]

// Rank/unread/activity row patches keep row ownership, so they must not re-walk every session tab.
export function ownerInputChanged(
  state: AppState,
  previous: AppState,
  key: keyof WorktreeRuntimeOwnerState
): boolean {
  return (
    state[key] !== previous[key] &&
    (key !== 'worktreesByRepo' ||
      worktreeOwnerRowsTokenOf(selectWorktreesByRepo(state)) !==
        worktreeOwnerRowsTokenOf(selectWorktreesByRepo(previous)))
  )
}

function ownerInputToken(state: AppState, key: keyof WorktreeRuntimeOwnerState): unknown {
  return key === 'worktreesByRepo'
    ? worktreeOwnerRowsTokenOf(selectWorktreesByRepo(state))
    : state[key]
}

/** Owners only change with owner inputs, so feed ticks and tab-map edits reuse each tab's resolution. */
export function createTabOwnerCache(): (
  state: AppState,
  tab: StructuredTab
) => ExecutionHostId | null {
  let inputs: unknown[] | null = null
  let owners = new WeakMap<StructuredTab, ExecutionHostId | null>()
  return (state, tab) => {
    const next = ownerInputs.map((key) => ownerInputToken(state, key))
    if (!inputs || next.some((input, index) => input !== inputs?.[index])) {
      inputs = next
      owners = new WeakMap()
    }
    if (!owners.has(tab)) {
      owners.set(tab, structuredAgentSessionOwnerForTab(state, tab))
    }
    return owners.get(tab) ?? null
  }
}
