import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isWebClientLocation } from './web-client-location'
import {
  resolveWorktreeOperationRoute,
  type WorktreeOperationRouteState
} from './worktree-operation-route'

export function canPickWorkspaceMarkdownDocument(
  state: WorktreeOperationRouteState,
  worktreeId: string
): boolean {
  const route = resolveWorktreeOperationRoute(state, worktreeId)
  // A native picker cannot select files on another execution host.
  return (
    !isWebClientLocation() &&
    route?.executionHostId === LOCAL_EXECUTION_HOST_ID &&
    route.runtimeEnvironmentId === null
  )
}
