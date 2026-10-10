import {
  LOCAL_EXECUTION_HOST_ID,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Tab } from '../../../shared/tab-types'
import {
  getExecutionHostIdForWorktree,
  type WorktreeRuntimeOwnerState
} from '@/lib/worktree-runtime-owner'
import { resolveIndexedWorktreeOwner } from '@/lib/worktree-runtime-owner-index'
import { LOCAL_STRUCTURED_SESSION_OWNER } from './local-structured-session-owner'
import { runtimeTargetForExecutionHostId, type RuntimeClientTarget } from './runtime-client-target'

/**
 * The one mapping from a chat's owning host to the runtime that serves it. Null for an owner no
 * runtime serves: an SSH host, or the catalog's unresolved-owner sentinel.
 */
export function structuredAgentSessionTargetForHost(
  executionHostId: string | null | undefined
): RuntimeClientTarget | null {
  const host = parseExecutionHostId(executionHostId)
  return host ? runtimeTargetForExecutionHostId(host.id) : null
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
  if (
    state.activeWorktreeId !== worktreeId &&
    resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId).kind === 'ambiguous'
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
