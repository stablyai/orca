import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { PtyListedSession, PtySessionListScope } from '../../../shared/pty-listed-session'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import {
  resolveIndexedRepoOwner,
  resolveIndexedWorktreeOwner
} from './worktree-runtime-owner-index'
import {
  resolveWorktreeOperationRouteResult,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

/** Main rejects a scoped list with this prefix when the relay is detached (pty/provider/registry.ts). */
const DETACHED_PROVIDER_REJECTION = 'No PTY provider for connection'

/**
 * The one provider that owns this workspace's PTYs, or `undefined` when the client cannot name a
 * provider it could reach.
 *
 * Why `undefined` rather than a throw: a paired-runtime workspace is never in this client's PTY
 * registry at all, so refusing to answer turns a healthy peer workspace into a `blocked` gate, and
 * activation then leaves it with no surface whatsoever. Falling back to the unscoped diagnostic
 * inventory reproduces the shipped answer for exactly those workspaces while the scoped fast path
 * still covers local, folder and attached-SSH ones.
 */
export function resolveActivationPtyListScope(
  state: WorktreeOperationRouteState,
  worktreeId: string
): PtySessionListScope | undefined {
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return { connectionId: null }
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind === 'missing' && !getRuntimeEnvironmentIdForWorktree(state, worktreeId)) {
    const repo = resolveIndexedRepoOwner(state.repos, getRepoIdFromWorktreeId(worktreeId))
    const worktree = resolveIndexedWorktreeOwner(state.worktreesByRepo, worktreeId)
    // A known native repo remains usable while the unrelated runtime catalog hydrates.
    if (
      repo.kind === 'resolved' &&
      !(state.activeWorktreeId === worktreeId && state.activeWorkspaceExecutionHostId) &&
      (worktree.kind === 'missing' ||
        (worktree.kind === 'resolved' &&
          !worktree.owner.hostId &&
          !worktree.owner.runtimeOwnerEnvironmentId)) &&
      !repo.owner.connectionId &&
      (!repo.owner.executionHostId || repo.owner.executionHostId === 'local')
    ) {
      return { connectionId: null }
    }
  }
  if (resolution.kind !== 'resolved' || resolution.route.runtimeEnvironmentId) {
    return undefined
  }
  const host = parseExecutionHostId(resolution.route.executionHostId)
  if (!host || host.kind === 'runtime') {
    // Paired hosts own their activation; a client inventory cannot authorize a writer there.
    return undefined
  }
  return { connectionId: host.kind === 'ssh' ? host.targetId : null }
}

/**
 * Activation's PTY census, scoped to the owning host whenever the client can name one.
 *
 * A detached relay is loss of contact, not evidence about the host, and it must not strand the
 * workspace: fall back to the same unscoped inventory that shipped so the gate still reaches a
 * verdict. Every other rejection is a real answer from the selected host and propagates.
 */
export async function listActivationPtySessions(
  state: WorktreeOperationRouteState,
  worktreeId: string
): Promise<PtyListedSession[]> {
  const scope = resolveActivationPtyListScope(state, worktreeId)
  if (!scope) {
    return window.api.pty.listSessions()
  }
  try {
    return await window.api.pty.listSessions(scope)
  } catch (error) {
    if (!String((error as Error)?.message ?? error).includes(DETACHED_PROVIDER_REJECTION)) {
      throw error
    }
    return window.api.pty.listSessions()
  }
}
