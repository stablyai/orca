import { resolveOwner } from '@/lib/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/worktree-operation-route'
import { authorityKey } from '../../../../../../shared/host-authority'

/** Terminal content still belongs to its placement workspace; a cwd cannot move execution to another host. */
export function canLaunchSourceControlSectionAgentInPlace(
  state: WorktreeOperationRouteState,
  worktreeId: string,
  placementWorkspaceId: string
): boolean {
  const content = resolveOwner(state, { workspaceId: worktreeId })
  const placement = resolveOwner(state, { workspaceId: placementWorkspaceId })
  return (
    content.kind === 'resolved' &&
    placement.kind === 'resolved' &&
    authorityKey(content.owner) === authorityKey(placement.owner)
  )
}
