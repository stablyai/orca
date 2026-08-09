import { useAppStore, type AppState } from '@/store'
import type { DetachedTerminalTabSeed } from '../../../../shared/types'

/** Seeds the pop-out window's own store instance with every tab the main
 * window handed off, so `TerminalPane` can resolve each tab/layout/pty state
 * exactly as it would in the main window. */
export function applyDetachedTerminalTabSeed(
  seed: DetachedTerminalTabSeed,
  activeTabId = seed.tab.id
): void {
  const entries = [seed, ...(seed.additionalTabs ?? [])]
  const selectedEntry = entries.find((entry) => entry.tab.id === activeTabId) ?? entries[0] ?? seed

  useAppStore.setState((state) => {
    const tabsByWorktree = { ...state.tabsByWorktree }
    const seededTabsByWorktree = new Map<string, DetachedTerminalTabSeed['tab'][]>()
    const activeTabIdByWorktree = { ...state.activeTabIdByWorktree }
    const terminalLayoutsByTabId = { ...state.terminalLayoutsByTabId }
    const ptyIdsByTabId = { ...state.ptyIdsByTabId }
    const reposById = new Map<string, AppState['repos'][number]>()

    for (const entry of entries) {
      const effectiveLayout = {
        ...entry.layout,
        ptyIdsByLeafId:
          entry.layout.ptyIdsByLeafId && Object.keys(entry.layout.ptyIdsByLeafId).length > 0
            ? entry.layout.ptyIdsByLeafId
            : entry.layout.activeLeafId && entry.ptyId
              ? { [entry.layout.activeLeafId]: entry.ptyId }
              : entry.layout.ptyIdsByLeafId
      }
      const worktreeTabs = seededTabsByWorktree.get(entry.worktreeId) ?? []
      seededTabsByWorktree.set(entry.worktreeId, [...worktreeTabs, entry.tab])
      terminalLayoutsByTabId[entry.tab.id] = effectiveLayout
      ptyIdsByTabId[entry.tab.id] = entry.ptyId ? [entry.ptyId] : []
      if (activeTabIdByWorktree[entry.worktreeId] === undefined) {
        activeTabIdByWorktree[entry.worktreeId] = entry.tab.id
      }
      reposById.set(entry.repo.id, entry.repo as AppState['repos'][number])
    }

    for (const [worktreeId, tabs] of seededTabsByWorktree) {
      tabsByWorktree[worktreeId] = tabs
    }
    activeTabIdByWorktree[selectedEntry.worktreeId] = selectedEntry.tab.id

    return {
      tabsByWorktree,
      terminalLayoutsByTabId,
      ptyIdsByTabId,
      activeTabId: selectedEntry.tab.id,
      activeTabIdByWorktree,
      activeTabType: 'terminal',
      activeTabTypeByWorktree: {
        ...state.activeTabTypeByWorktree,
        [selectedEntry.worktreeId]: 'terminal'
      },
      repos: [...reposById.values()]
    }
  })
}
