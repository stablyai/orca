import { toast } from 'sonner'
import { useAppStore } from '@/store/index'
import { translate } from '@/i18n/i18n'
import { resolveWorktreeDisplayName } from '@/lib/workspace/display/worktree-default-display-name'
import { workspaceNavigationToastAction } from '@/lib/workspace/activation/workspace-navigation-toast-action'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { resolveOwner } from '@/lib/workspace/ownership/resolve-owner'
import type { WorktreeOperationRouteState } from '@/lib/workspace/ownership/worktree-operation-route'
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

export function showSourceControlAgentStartedIn(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): void {
  const worktree = useAppStore.getState().getKnownWorktreeById(worktreeId, executionHostId)
  const name = worktree
    ? resolveWorktreeDisplayName(worktree)
    : translate('auto.components.sidebar.WorktreeContextMenu.workspaceSection', 'Workspace')
  toast.success(
    translate('sourceControl.sectionAgentStarted', 'Started in {{value0}}', { value0: name }),
    {
      action: workspaceNavigationToastAction({ workspaceId: worktreeId, executionHostId })
    }
  )
}
