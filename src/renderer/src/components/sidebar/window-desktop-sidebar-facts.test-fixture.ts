import type { AppState } from '@/store'
import { getAllWorktreesFromState } from '@/store/selectors'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  toRuntimeExecutionHostId,
  toSshExecutionHostId
} from '../../../../shared/execution-host'
import type { DesktopSidebarFacts } from '../../../../shared/sidebar-list/desktop-sidebar-facts'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'

type WindowFactsState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeWorkspaceExecutionHostId'
  | 'worktreesByRepo'
  | 'folderWorkspaces'
  | 'repos'
  | 'workspaceHostOrder'
  | 'sshTargetLabels'
  | 'sshConnectionStates'
  | 'wslHostStatuses'
>

/** The same facts from the window's own store, in main's shape, for the rows the local runtime owns. */
export function readWindowDesktopSidebarFacts(state: WindowFactsState): DesktopSidebarFacts {
  const pinned = [
    ...getAllWorktreesFromState(state)
      .filter((worktree) => worktree.isPinned)
      .map((worktree) => worktree.id),
    ...state.folderWorkspaces
      .filter((folder) => folder.isPinned)
      .map((folder) => folderWorkspaceKey(folder.id))
  ]
  return {
    desktopActive: {
      hostId: state.activeWorkspaceExecutionHostId ?? null,
      worktreeId: state.activeWorktreeId ?? null
    },
    pinnedWorkspaceIds: [...new Set(pinned)].sort(),
    repoOrder: state.repos
      .map((repo) => ({ hostId: getRepoExecutionHostId(repo), repoId: repo.id }))
      .filter((entry) => parseExecutionHostId(entry.hostId)?.kind !== 'runtime'),
    workspaceHostOrder: [...state.workspaceHostOrder],
    sshHosts: Object.fromEntries(
      [...state.sshTargetLabels].map(([targetId, label]) => [
        toSshExecutionHostId(targetId),
        { label, status: state.sshConnectionStates.get(targetId)?.status ?? null }
      ])
    ),
    wslHosts: Object.fromEntries(
      Object.values(state.wslHostStatuses).map((status) => [
        toRuntimeExecutionHostId(status.environmentId),
        { distro: status.distro, state: status.state }
      ])
    )
  }
}
