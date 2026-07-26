import { useAppStore, type AppState } from '@/store'
import type { DetachedTerminalTabSeed } from '../../../../shared/types'

/** Seeds the pop-out window's own store instance with the single tab the main
 *  window handed off, so `TerminalPane` can resolve tab/layout/pty state
 *  exactly as it would in the main window. */
export function applyDetachedTerminalTabSeed(seed: DetachedTerminalTabSeed): void {
  const { tab, layout, ptyId, worktreeId, repo } = seed
  const effectiveLayout = {
    ...layout,
    ptyIdsByLeafId:
      layout.ptyIdsByLeafId && Object.keys(layout.ptyIdsByLeafId).length > 0
        ? layout.ptyIdsByLeafId
        : layout.activeLeafId && ptyId
          ? { [layout.activeLeafId]: ptyId }
          : layout.ptyIdsByLeafId
  }
  useAppStore.setState((state) => ({
    tabsByWorktree: { ...state.tabsByWorktree, [worktreeId]: [tab] },
    terminalLayoutsByTabId: { ...state.terminalLayoutsByTabId, [tab.id]: effectiveLayout },
    ptyIdsByTabId: { ...state.ptyIdsByTabId, [tab.id]: ptyId ? [ptyId] : [] },
    activeTabId: tab.id,
    activeTabIdByWorktree: { ...state.activeTabIdByWorktree, [worktreeId]: tab.id },
    // Why: the terminal route resolver needs repos to resolve the worktree's
    // execution host — without this the popout gets "Workspace identity is ambiguous".
    repos: [repo as AppState['repos'][number]]
  }))
}
