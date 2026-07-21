import { useAppStore } from '..'
import type { DetachedTerminalSnapshot } from '../../../../shared/detached-terminal-window'

export function hydrateDetachedTerminalSnapshot(snapshot: DetachedTerminalSnapshot): void {
  if (snapshot.ptyIds.length === 0) {
    useAppStore.setState({ hydrationSucceeded: false, workspaceSessionReady: false })
    return
  }

  const buffersByLeafId = { ...snapshot.terminalLayout.buffersByLeafId }
  for (const [leafId, bufferSnapshot] of Object.entries(snapshot.bufferSnapshotsByLeafId)) {
    buffersByLeafId[leafId] = bufferSnapshot.data
  }
  const terminalLayout = {
    ...snapshot.terminalLayout,
    buffersByLeafId
  }

  useAppStore.setState({
    tabsByWorktree: { [snapshot.worktree.id]: [snapshot.terminalTab] },
    ptyIdsByTabId: { [snapshot.terminalTab.id]: snapshot.ptyIds },
    unifiedTabsByWorktree: { [snapshot.worktree.id]: [snapshot.unifiedTab] },
    groupsByWorktree: { [snapshot.worktree.id]: [snapshot.group] },
    layoutByWorktree: { [snapshot.worktree.id]: snapshot.groupLayout },
    activeGroupIdByWorktree: { [snapshot.worktree.id]: snapshot.activeGroupId },
    activeTabIdByWorktree: { [snapshot.worktree.id]: snapshot.activeTabId },
    terminalLayoutsByTabId: { [snapshot.terminalTab.id]: terminalLayout },
    settings: snapshot.settings,
    repos: snapshot.repos,
    worktreesByRepo: snapshot.worktreesByRepo,
    ...(snapshot.keybindings
      ? {
          keybindings: snapshot.keybindings.overrides,
          keybindingSnapshot: snapshot.keybindings
        }
      : {}),
    activeWorktreeId: snapshot.worktree.id,
    activeTabId: snapshot.terminalTab.id,
    activeTabType: 'terminal',
    workspaceSessionReady: true,
    hydrationSucceeded: true
  })
}
