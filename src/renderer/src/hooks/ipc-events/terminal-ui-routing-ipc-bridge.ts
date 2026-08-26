import { SPLIT_TERMINAL_PANE_EVENT } from '@/constants/terminal'
import type { SplitTerminalPaneDetail } from '@/constants/terminal'
import { activateTabAndFocusPane } from '@/lib/activate-tab-and-focus-pane'
import { useAppStore } from '../../store'
import { resolveBrowserSessionTabTarget } from './browser-session-tab-target'
import {
  activateTerminalInitiatedWorktree,
  focusTerminalInitiatedTab
} from './terminal-command-state'

export function registerTerminalUiRoutingIpcBridge(unsubs: (() => void)[]): void {
  unsubs.push(
    window.api.ui.onSplitTerminal(
      ({ tabId, paneRuntimeId, direction, command, telemetrySource }) => {
        const detail: SplitTerminalPaneDetail = {
          tabId,
          paneRuntimeId,
          direction,
          command,
          telemetrySource
        }
        window.dispatchEvent(new CustomEvent(SPLIT_TERMINAL_PANE_EVENT, { detail }))
      }
    )
  )

  unsubs.push(
    window.api.ui.onRenameTerminal(({ tabId, title }) => {
      useAppStore.getState().setTabCustomTitle(tabId, title)
    })
  )

  unsubs.push(
    window.api.ui.onFocusTerminal(
      ({
        tabId,
        worktreeId,
        leafId,
        ackPaneKeyOnSuccess,
        flashFocusedPane,
        scrollToBottomIfOutputSinceLastView
      }) => {
        const store = useAppStore.getState()
        activateTerminalInitiatedWorktree(store, worktreeId)
        store.setActiveTab(tabId)
        store.revealWorktreeInSidebar(worktreeId)
        if (ackPaneKeyOnSuccess || flashFocusedPane || scrollToBottomIfOutputSinceLastView) {
          activateTabAndFocusPane(tabId, leafId ?? null, {
            ...(ackPaneKeyOnSuccess ? { ackPaneKeyOnSuccess } : {}),
            ...(flashFocusedPane ? { flashFocusedPane: true } : {}),
            ...(scrollToBottomIfOutputSinceLastView
              ? { scrollToBottomIfOutputSinceLastView: true }
              : {})
          })
          return
        }
        focusTerminalInitiatedTab(tabId, leafId)
      }
    )
  )

  unsubs.push(
    window.api.ui.onFocusEditorTab(({ tabId, worktreeId }) => {
      const store = useAppStore.getState()
      const tab = (store.unifiedTabsByWorktree[worktreeId] ?? []).find((item) => item.id === tabId)
      const browserTarget = resolveBrowserSessionTabTarget(store, worktreeId, tabId)
      if (!tab) {
        if (browserTarget) {
          // Why: older/mobile fallback snapshots identify browser tabs by workspace id when no unified tab wrapper exists.
          store.setActiveWorktree(worktreeId)
          store.markWorktreeVisited(worktreeId)
          store.setActiveView('terminal')
          store.setActiveBrowserTab(browserTarget.workspaceId)
          store.setActiveTabType('browser')
          store.revealWorktreeInSidebar(worktreeId)
        }
        return
      }
      store.setActiveWorktree(worktreeId)
      store.markWorktreeVisited(worktreeId)
      store.setActiveView('terminal')
      store.focusGroup(worktreeId, tab.groupId)
      store.activateTab(tab.id)
      if (browserTarget) {
        // Why: browser tabs need their own active-page state, not the editor file activation path.
        store.setActiveBrowserTab(browserTarget.workspaceId)
        store.setActiveTabType('browser')
      } else {
        store.setActiveFile(tab.entityId)
        store.setActiveTabType('editor')
      }
      store.revealWorktreeInSidebar(worktreeId)
    })
  )
}
