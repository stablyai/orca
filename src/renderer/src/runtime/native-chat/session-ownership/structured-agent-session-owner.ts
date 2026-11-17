import {
  selectDetectedWorktreesByRepo,
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../../../shared/execution-host/execution-host'
import type { Tab } from '../../../../../shared/workspace-layout/tab-groups/tab-types'
import { getExecutionHostIdForWorktree } from '@/lib/workspace/ownership/worktree-runtime-owner'
import type { AppState } from '@/store/types'
import type { WorktreeRuntimeOwnerState } from '@/lib/workspace/ownership/worktree-runtime-owner-state'
import {
  isTwinWorkspace,
  namedHostForOwnerRef,
  resolveOwner
} from '@/lib/workspace/ownership/resolve-owner'
import { authorityKey } from '../../../../../shared/execution-host/host-authority'
import { LOCAL_STRUCTURED_SESSION_OWNER } from '../local-sessions/local-structured-session-owner'
import { runtimeRpcTargetForAuthorityKey } from '../../rpc/targets/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import {
  replacedWorktreeRows,
  sameDetectedWorktreeMembership
} from '@/store/slices/worktrees/listing/worktree-catalog-membership'

/**
 * The one mapping from a chat's owning host to the runtime that serves it. Null for an owner no
 * runtime serves: an SSH host, or the catalog's unresolved-owner sentinel.
 */
export function structuredAgentSessionTargetForHost(
  executionHostId: unknown
): RuntimeClientTarget | null {
  // Render reads unchecked tab and wire stamps: a non-string owner has no runtime, not a crash.
  const host = typeof executionHostId === 'string' ? parseExecutionHostId(executionHostId) : null
  return host ? runtimeRpcTargetForAuthorityKey(host.id) : null
}

/**
 * The host that would own a new structured chat in this workspace: the one every other operation
 * on it routes to. Worktree ids (`repoId::path`) repeat across hosts, so an id two hosts publish is
 * refused unless the active workspace's host selection qualifies it, and so is an owner no runtime
 * serves; neither falls back to this machine.
 */
export function resolveStructuredAgentSessionOwner(
  state: WorktreeRuntimeOwnerState,
  worktreeId: string
): ExecutionHostId | null {
  // Owner resolution detects folder twins and active twins lacking host choice; default-local fallback would misroute them.
  if (
    !namedHostForOwnerRef(state, { workspaceId: worktreeId }) &&
    isTwinWorkspace(state, worktreeId)
  ) {
    return null
  }
  const executionHostId = getExecutionHostIdForWorktree(state, worktreeId)
  return structuredAgentSessionTargetForHost(executionHostId) ? executionHostId : null
}

/**
 * Where an existing chat lives: the host stamped on its tab when it was launched or mirrored. A tab
 * from before that stamp existed resolves from its workspace; null when neither names a runtime.
 */
export function structuredAgentSessionTargetForTab(
  state: WorktreeRuntimeOwnerState,
  tab: Pick<Tab, 'worktreeId' | 'executionHostId'>
): RuntimeClientTarget | null {
  return structuredAgentSessionTargetForHost(structuredAgentSessionOwnerForTab(state, tab))
}

/** The host recorded for an existing chat, as a string a store selector can compare. */
export function structuredAgentSessionOwnerForTab(
  state: WorktreeRuntimeOwnerState,
  tab: Pick<Tab, 'worktreeId' | 'executionHostId'>
): ExecutionHostId | null {
  return tab.executionHostId ?? resolveStructuredAgentSessionOwner(state, tab.worktreeId)
}

/** Automatic transfer cannot treat a selected twin or the routing default as ownership evidence. */
export function legacyStructuredChatRenameOwner(
  state: WorktreeRuntimeOwnerState,
  tab: Pick<Tab, 'worktreeId' | 'executionHostId'>
): ExecutionHostId | null {
  if (tab.executionHostId) {
    return tab.executionHostId
  }
  const owner = resolveOwner(
    {
      ...state,
      activeWorktreeId: null,
      activeWorkspaceExecutionHostId: null,
      restoredRuntimeHostIdByWorkspaceSessionKey: undefined
    },
    { workspaceId: tab.worktreeId }
  )
  const host = owner.kind === 'resolved' ? parseExecutionHostId(authorityKey(owner.owner)) : null
  return host && structuredAgentSessionTargetForHost(host.id) ? host.id : null
}

/** Catalog inputs independent of the user's current workspace selection. */
export function structuredAgentSessionCatalogOwnerInputs(
  state: WorktreeRuntimeOwnerState
): unknown[] {
  return [
    state.repos,
    selectWorktreesByRepo(state),
    selectDetectedWorktreesByRepo(state),
    selectFolderWorkspaces(state),
    state.projectGroups,
    state.runtimeEnvironments,
    state.runtimeEnvironmentCatalogHydrated
  ]
}

/** Inputs to the legacy workspace-owner resolver, compared before scanning chat tabs. */
export function structuredAgentSessionOwnerInputs(state: WorktreeRuntimeOwnerState): unknown[] {
  return [
    ...structuredAgentSessionCatalogOwnerInputs(state),
    state.settings,
    state.restoredRuntimeHostIdByWorkspaceSessionKey,
    state.removedRuntimeEnvironmentIds,
    state.activeWorktreeId,
    state.activeWorkspaceExecutionHostId
  ]
}

/** The catalog maps the owner-input compare reads. */
export type OwnerCatalogState = Pick<AppState, 'worktreesByRepo' | 'detectedWorktreesByRepo'>

/** Compares owner inputs; a worktree map that only replaced rows in place (a title write) moves no owner. */
export function structuredAgentSessionOwnerInputsMoved(
  state: OwnerCatalogState,
  previous: OwnerCatalogState,
  inputs: readonly unknown[],
  previousInputs: readonly unknown[]
): boolean {
  const worktrees = selectWorktreesByRepo(state)
  const detected = selectDetectedWorktreesByRepo(state)
  return inputs.some((value, index) => {
    if (value === previousInputs[index]) {
      return false
    }
    if (value === worktrees) {
      return replacedWorktreeRows(worktrees, selectWorktreesByRepo(previous)) === null
    }
    if (value === detected) {
      return !sameDetectedWorktreeMembership(detected, selectDetectedWorktreesByRepo(previous))
    }
    return true
  })
}

/** The host a runtime target serves, for bookkeeping keyed by host. */
export function executionHostIdForStructuredTarget(target: RuntimeClientTarget): ExecutionHostId {
  return target.kind === 'local'
    ? LOCAL_EXECUTION_HOST_ID
    : toRuntimeExecutionHostId(target.environmentId)
}

/** The focus-intent owner key the tab sync for `target` resolves intents under. */
export function structuredAgentSessionFocusOwner(target: RuntimeClientTarget): {
  environmentId: string
} {
  return {
    environmentId: target.kind === 'local' ? LOCAL_STRUCTURED_SESSION_OWNER : target.environmentId
  }
}
