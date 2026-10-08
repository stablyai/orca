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

/** Only a reachable execution-owner route can authorize activation from its inventory. */
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

/** An unavailable execution host cannot be replaced with the client's diagnostic inventory. */
export async function listActivationPtySessions(
  state: WorktreeOperationRouteState,
  worktreeId: string
): Promise<PtyListedSession[]> {
  const scope = resolveActivationPtyListScope(state, worktreeId)
  if (!scope) {
    throw new Error('Activation PTY inventory is unverifiable: no execution-owner route')
  }
  return window.api.pty.listSessions(scope)
}
