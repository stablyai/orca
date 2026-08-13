import type { CreateWorktreeResult, Worktree } from '../../../shared/types'
import type { WorktreeCreationRequest } from './pending-worktree-creation'
import { resolveExplicitWorktreeOperationRouteResult } from './worktree-operation-route'

type RouteState = Parameters<typeof resolveExplicitWorktreeOperationRouteResult>[0]

export function canSeedCreatedWorktreeInBackground(
  state: RouteState,
  worktree: Pick<Worktree, 'id' | 'hostId'>
): boolean {
  if (!worktree.hostId) {
    return true
  }
  const resolution = resolveExplicitWorktreeOperationRouteResult(state, worktree.id)
  return resolution.kind === 'resolved' && resolution.route.executionHostId === worktree.hostId
}

export function hasCreatedWorktreeTerminalHandoff(
  request: WorktreeCreationRequest,
  result: CreateWorktreeResult
): boolean {
  return Boolean(request.startupPlan || result.setup || request.issueCommand || result.defaultTabs)
}
