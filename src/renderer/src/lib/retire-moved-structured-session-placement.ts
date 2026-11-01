import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { ExecutionHostId } from '../../../shared/execution-host'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { isFloatingWorkspaceId } from '../../../shared/floating-workspace-worktree'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import {
  executionHostIdForStructuredTarget,
  structuredAgentSessionOwnerForTab
} from '@/runtime/structured-agent-session-owner'
import { createKeptWorktreeSurfacePruners } from '@/store/slices/tabs/kept-worktree-surface-pruning'
import { selectFolderWorkspaces } from '@/store/workspace-record-selectors'

/** Remove a chat's tabs owned by `owner` from the given workspaces, without closing the chat. */
function pruneChatTabs(
  sessionsByWorkspace: ReadonlyMap<string, ReadonlySet<string>>,
  owner: ExecutionHostId
): void {
  const state = useAppStore.getState()
  const ids = new Set<string>()
  for (const [workspace, sessions] of sessionsByWorkspace) {
    for (const tab of state.unifiedTabsByWorktree[workspace] ?? []) {
      if (
        tab.contentType === 'agent-session' &&
        sessions.has(tab.entityId) &&
        structuredAgentSessionOwnerForTab(state, tab) === owner
      ) {
        ids.add(tab.id)
      }
    }
  }
  if (ids.size) {
    const prune = createKeptWorktreeSurfacePruners(state, {
      worktreeIds: new Set(sessionsByWorkspace.keys()),
      unifiedTabIds: ids,
      terminalTabIds: new Set(),
      fileIds: new Set(),
      browserTabIds: new Set()
    })
    useAppStore.setState({
      unifiedTabsByWorktree: prune.unifiedTabs(state.unifiedTabsByWorktree),
      groupsByWorktree: prune.groups(state.groupsByWorktree),
      tabBarOrderByWorktree: prune.tabBarOrder(state.tabBarOrderByWorktree)
    })
  }
}

export function retireMovedSessionPlacement(
  sessionId: string,
  oldWorkspace: string,
  currentWorkspace: string,
  host: RuntimeClientTarget
): void {
  if (currentWorkspace !== oldWorkspace) {
    pruneChatTabs(
      new Map([[oldWorkspace, new Set([sessionId])]]),
      executionHostIdForStructuredTarget(host)
    )
  }
}

/** A chat the host newly places in a workspace leaves this window's local tabs in retired
 *  workspaces; registered ones stay, so a late reply for another workspace cannot hide it. */
export function retireLocalSessionPlacementsOutside(
  placed: readonly { worktreeId: string; sessionId: string }[],
  framesDraw?: (worktreeId: string) => boolean
): void {
  if (placed.length === 0) {
    return
  }
  const state = useAppStore.getState()
  const repoIds = new Set((state.repos ?? []).map((repo) => repo.id))
  const folderIds = new Set(selectFolderWorkspaces(state).map((folder) => folder.id))
  const retired = new Map<string, ReadonlySet<string>>()
  for (const workspace of Object.keys(state.unifiedTabsByWorktree)) {
    const scope = parseWorkspaceKey(workspace)
    if (
      isFloatingWorkspaceId(workspace) ||
      framesDraw?.(workspace) ||
      (scope?.type === 'folder'
        ? folderIds.has(scope.folderWorkspaceId)
        : repoIds.has(getRepoIdFromWorktreeId(workspace)))
    ) {
      continue
    }
    retired.set(
      workspace,
      new Set(placed.filter((row) => row.worktreeId !== workspace).map((row) => row.sessionId))
    )
  }
  if (retired.size) {
    pruneChatTabs(retired, LOCAL_EXECUTION_HOST_ID)
  }
}
