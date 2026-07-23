import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import type { AppState } from '@/store/types'
import { getRuntimeEnvironmentIdForWorktree } from './worktree-runtime-owner'
import { resolveWorktreeOperationRouteResult } from './worktree-operation-route'
import { getSingleFocusedRuntimeEnvironmentId } from './single-runtime-legacy-owner'

export type TerminalWorktreeRoute = {
  runtimeEnvironmentId: string | null
}

export function resolveTerminalWorktreeRoute(
  state: AppState,
  worktreeId: string | null | undefined
): TerminalWorktreeRoute | null {
  if (!worktreeId) {
    return { runtimeEnvironmentId: null }
  }
  if (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    parseWorkspaceKey(worktreeId)?.type === 'folder'
  ) {
    return { runtimeEnvironmentId: getRuntimeEnvironmentIdForWorktree(state, worktreeId) }
  }
  const resolution = resolveWorktreeOperationRouteResult(state, worktreeId)
  if (resolution.kind === 'resolved') {
    return { runtimeEnvironmentId: resolution.route.runtimeEnvironmentId }
  }
  if (
    state.worktreesByRepo === undefined &&
    state.detectedWorktreesByRepo === undefined &&
    state.repos === undefined
  ) {
    // Why: narrow unit/legacy adapters can omit all owner catalogs; production stores always provide them and still fail closed above.
    return { runtimeEnvironmentId: getSingleFocusedRuntimeEnvironmentId(state) }
  }
  return null
}

export function hasUnroutableTerminalWorktreeOwner(state: AppState, worktreeId: string): boolean {
  return resolveTerminalWorktreeRoute(state, worktreeId) === null
}
