import type { AppState } from '@/store/types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { authorityKey } from '../../../shared/host-authority'
import { isExecutionHostAliasForWorktree } from './worktree-execution-host-alias'
import { resolveOwner } from './resolve-owner'

export function createBrowserLinkHostMatcher(
  state: AppState,
  worktreeId: string,
  executionHostId: ExecutionHostId
): (hostId: ExecutionHostId | null | undefined) => boolean {
  const worktree = state.getKnownWorktreeById(worktreeId, executionHostId)
  let matchesLegacyHost: boolean | undefined
  return (hostId) => {
    if (hostId) {
      return (
        hostId === executionHostId ||
        Boolean(
          worktree &&
          isExecutionHostAliasForWorktree(executionHostId, worktree) &&
          isExecutionHostAliasForWorktree(hostId, worktree)
        )
      )
    }
    if (matchesLegacyHost === undefined) {
      // A selected host cannot disambiguate a legacy tab that never named its owner.
      const owner = resolveOwner(
        { ...state, activeWorkspaceExecutionHostId: null },
        { workspaceId: worktreeId }
      )
      const destinationOwner = resolveOwner(state, {
        workspaceId: worktreeId,
        hostId: executionHostId
      })
      matchesLegacyHost =
        owner.kind === 'resolved' &&
        destinationOwner.kind === 'resolved' &&
        (authorityKey(owner.owner) === authorityKey(destinationOwner.owner) ||
          Boolean(worktree && isExecutionHostAliasForWorktree(executionHostId, worktree)))
    }
    return matchesLegacyHost
  }
}
