import type { AppState } from '@/store/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { normalizeExecutionHostId } from '../../../shared/execution-host'
import { translate } from '@/i18n/i18n'

type MaestroWorkspaceNavigationState = Pick<
  AppState,
  | 'folderWorkspaces'
  | 'projectGroups'
  | 'repos'
  | 'worktreesByRepo'
  | 'unifiedTabsByWorktree'
  | 'setActiveWorktree'
  | 'setActiveFolderWorkspace'
  | 'setSidebarOpen'
  | 'createUnifiedTab'
  | 'activateTab'
>

function folderWorkspaceHostId(
  state: Pick<MaestroWorkspaceNavigationState, 'projectGroups'>,
  workspace: AppState['folderWorkspaces'][number]
): string {
  return (
    normalizeExecutionHostId(workspace.executionHostId) ??
    normalizeExecutionHostId(
      state.projectGroups.find((group) => group.id === workspace.projectGroupId)?.executionHostId
    ) ??
    'local'
  )
}

export function openExactMaestroWorkspace(
  state: MaestroWorkspaceNavigationState,
  target: { executionHostId: string; workspaceKey: string }
): boolean {
  const hostId = normalizeExecutionHostId(target.executionHostId)
  const scope = parseWorkspaceKey(target.workspaceKey)
  if (!hostId || !scope) {
    return false
  }

  const workspaceId = scope.type === 'folder' ? target.workspaceKey : scope.worktreeId
  if (scope.type === 'folder') {
    const workspace = state.folderWorkspaces.find(
      (candidate) =>
        candidate.id === scope.folderWorkspaceId &&
        folderWorkspaceHostId(state, candidate) === hostId &&
        !candidate.isArchived
    )
    if (!workspace) {
      return false
    }
    state.setActiveFolderWorkspace(scope.folderWorkspaceId, hostId)
  } else {
    const worktree = Object.values(state.worktreesByRepo)
      .flat()
      .find((candidate) => candidate.id === scope.worktreeId)
    const repo = worktree ? state.repos.find((candidate) => candidate.id === worktree.repoId) : null
    const repoHostId = repo
      ? (normalizeExecutionHostId(repo.executionHostId) ??
        (repo.connectionId ? `ssh:${encodeURIComponent(repo.connectionId)}` : 'local'))
      : null
    if (!worktree || worktree.isArchived || (worktree.hostId ?? repoHostId) !== hostId) {
      return false
    }
    if (!state.setActiveWorktree(scope.worktreeId, hostId)) {
      return false
    }
  }

  state.setSidebarOpen(true)
  const existing = (state.unifiedTabsByWorktree[workspaceId] ?? []).find(
    (tab) =>
      tab.contentType === 'maestro' &&
      tab.maestroExecutionHostId === hostId &&
      tab.maestroWorkspaceKey === target.workspaceKey
  )
  if (existing) {
    state.activateTab(existing.id, { worktreeId: workspaceId })
    return true
  }
  state.createUnifiedTab(workspaceId, 'maestro', {
    label: translate('auto.components.maestro.tab.title', 'Maestro'),
    maestroExecutionHostId: hostId,
    maestroWorkspaceKey: target.workspaceKey
  })
  return true
}
