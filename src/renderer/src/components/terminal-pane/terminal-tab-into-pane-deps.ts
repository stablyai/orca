import {
  SET_TERMINAL_PANE_TITLE_EVENT,
  SPLIT_TERMINAL_PANE_EVENT,
  TOGGLE_TERMINAL_PANE_EXPAND_EVENT
} from '@/constants/terminal'
import type { SetTerminalPaneTitleDetail, SplitTerminalPaneDetail } from '@/constants/terminal'
import { scheduleRuntimeGraphSync } from '@/runtime/sync-runtime-graph'
import { useAppStore } from '@/store'
import { moveTerminalTabIntoPane } from './terminal-tab-into-pane-move'
import type {
  TerminalTabIntoPaneArgs,
  TerminalTabIntoPaneDeps,
  TerminalTabIntoPaneOutcome
} from './terminal-tab-into-pane-types'
import { getParkedTerminalWatcherTabIds } from './terminal-parked-watcher-registry'
import { syncParkedTerminalTabWatchers } from './terminal-parked-tab-watchers'

function mountedLeafIds(tabId: string): string[] | null {
  const roots = document.querySelectorAll<HTMLElement>(
    `[data-terminal-tab-id="${CSS.escape(tabId)}"]`
  )
  if (roots.length === 0) {
    return null
  }
  return Array.from(roots).flatMap((root) =>
    Array.from(root.querySelectorAll<HTMLElement>('.pane[data-leaf-id]')).flatMap((pane) =>
      pane.dataset.leafId ? [pane.dataset.leafId] : []
    )
  )
}

export function createTerminalTabIntoPaneDeps(): TerminalTabIntoPaneDeps {
  return {
    getStore: () => useAppStore.getState(),
    mountedLeafIds,
    dispatchSplit: (detail) =>
      window.dispatchEvent(
        new CustomEvent<SplitTerminalPaneDetail>(SPLIT_TERMINAL_PANE_EVENT, { detail })
      ),
    dispatchToggleExpand: (tabId) =>
      window.dispatchEvent(
        new CustomEvent(TOGGLE_TERMINAL_PANE_EXPAND_EVENT, { detail: { tabId } })
      ),
    dispatchPaneTitle: (detail) =>
      window.dispatchEvent(
        new CustomEvent<SetTerminalPaneTitleDetail>(SET_TERMINAL_PANE_TITLE_EVENT, { detail })
      ),
    scheduleGraphSync: scheduleRuntimeGraphSync,
    resyncParkedWatchers: (worktreeId, targetTabId) => {
      // Watchers exist only for parked tabs; a mounted target re-registers through its own panes.
      const parkedTabIds = new Set(getParkedTerminalWatcherTabIds())
      if (parkedTabIds.has(targetTabId)) {
        syncParkedTerminalTabWatchers({
          worktreeId,
          tabs: useAppStore.getState().tabsByWorktree[worktreeId] ?? [],
          parkedTabIds
        })
      }
    },
    readMainSession: () => window.api.session.get(),
    moveLeafIntoTab: (request) => window.api.pty.moveLeafIntoTab(request)
  }
}

export function moveTerminalTabIntoPaneInApp(
  args: TerminalTabIntoPaneArgs
): Promise<TerminalTabIntoPaneOutcome> {
  return moveTerminalTabIntoPane(args, createTerminalTabIntoPaneDeps())
}
