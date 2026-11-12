import type { AppState } from '@/store/types'
import { getIndexedAllWorktrees } from '@/store/slices/worktrees/listing/worktree-catalog-index'
import { getWorktreeOnHostFromState } from '@/store/workspaces/selection/worktree-on-host-selector'
import { findFolderWorkspaceRecord } from '@/store/folder-workspaces/folder-workspace-record-index'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { ExecutionHostId } from '../../../../../../shared/execution-host'
import { folderWorkspaceToWorktree } from '../../../../../../shared/folder-workspaces/folder-workspace-worktree'
import {
  getExecutionHostIdFromWorktreeHostIdentity,
  getWorktreeHostIdentity
} from '../../../../../../shared/worktree/host-qualified-identity'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { hasSleepableWorkspaceActivity } from '../context-menu/workspace-lineage-menu-actions'
import { getDeleteStateForWorktreeHost } from '../deletion/worktree-delete-state-host-match'

type SleepShortcutState = Pick<
  AppState,
  | 'activeWorkspaceExecutionHostId'
  | 'activeWorktreeId'
  | 'agentStatusByPaneKey'
  | 'browserTabsByWorktree'
  | 'deleteStateByWorktreeId'
  | 'folderWorkspaces'
  | 'ptyIdsByTabId'
  | 'structuredChatSleptAtByPaneKey'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
  | 'worktreesByRepo'
>
type HoveredWorkspace = { hostIdentity: string; workspaceId: string }

function folderWorkspace(
  state: SleepShortcutState,
  workspaceId: string,
  hostId: ExecutionHostId | undefined
): Worktree | undefined {
  const scope = parseWorkspaceKey(workspaceId)
  if (scope?.type !== 'folder') {
    return undefined
  }
  const record = findFolderWorkspaceRecord(
    selectFolderWorkspaces(state),
    scope.folderWorkspaceId,
    hostId
  )
  return record ? folderWorkspaceToWorktree(record) : undefined
}

function hoveredWorkspace(
  state: SleepShortcutState,
  hovered: HoveredWorkspace
): Worktree | undefined {
  if (parseWorkspaceKey(hovered.workspaceId)?.type === 'folder') {
    return folderWorkspace(
      state,
      hovered.workspaceId,
      getExecutionHostIdFromWorktreeHostIdentity(hovered.hostIdentity)
    )
  }
  return getIndexedAllWorktrees(selectWorktreesByRepo(state)).find(
    (worktree) =>
      worktree.id === hovered.workspaceId &&
      getWorktreeHostIdentity(worktree) === hovered.hostIdentity
  )
}

function activeWorkspace(state: SleepShortcutState): Worktree | undefined {
  const { activeWorktreeId, activeWorkspaceExecutionHostId } = state
  if (!activeWorktreeId) {
    return undefined
  }
  const hostId = activeWorkspaceExecutionHostId ?? undefined
  return parseWorkspaceKey(activeWorktreeId)?.type === 'folder'
    ? folderWorkspace(state, activeWorktreeId, hostId)
    : getWorktreeOnHostFromState(state, activeWorktreeId, hostId)
}

/** What the right-click Sleep item would sleep: the selection holding the hovered card, the hovered card, else the active workspace. */
export function resolveWorkspaceSleepShortcutTargets(
  state: SleepShortcutState,
  selection: readonly Worktree[],
  hovered: HoveredWorkspace | null
): Worktree[] {
  const single = (): Worktree[] => {
    const target = hovered ? hoveredWorkspace(state, hovered) : activeWorkspace(state)
    return target ? [target] : []
  }
  const context =
    hovered &&
    selection.length > 1 &&
    selection.some((worktree) => getWorktreeHostIdentity(worktree) === hovered.hostIdentity)
      ? selection
      : single()
  // Why: the menu disables Sleep while any workspace in its context is being deleted.
  if (
    context.some(
      (worktree) =>
        getDeleteStateForWorktreeHost(worktree, state.deleteStateByWorktreeId)?.isDeleting
    )
  ) {
    return []
  }
  return context.filter((worktree) => hasSleepableWorkspaceActivity(worktree.id, state))
}
