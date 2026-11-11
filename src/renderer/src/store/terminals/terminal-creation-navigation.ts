import { useAppStore } from '@/store/index'
import type { AppState } from '../types'
import { resolveWebSessionVisibleTabId } from '@/runtime/web-session-tabs-sync/navigation/web-session-focus-intent'
import { activateTabAndFocusPane } from '@/lib/workspace/tabs/activate-tab-and-focus-pane'

function selection(state: AppState): string {
  const workspace = state.activeWorktreeId
  const tab = workspace ? resolveWebSessionVisibleTabId(state, workspace) : state.activeTabId
  return JSON.stringify([
    workspace,
    state.activeWorkspaceExecutionHostId,
    workspace ? state.activeGroupIdByWorktree[workspace] : null,
    tab,
    tab ? state.terminalLayoutsByTabId[tab]?.activeLeafId : null,
    workspace ? state.activeTabTypeByWorktree[workspace] : null
  ])
}

/** A later selection wins even if the user returns before the host answers. */
export function captureTerminalCreationNavigation(): {
  current: () => boolean
  dispose: () => void
} {
  const initial = selection(useAppStore.getState())
  let current = true
  const dispose = useAppStore.subscribe((state) => {
    if (selection(state) !== initial) {
      current = false
    }
  })
  return { current: () => current, dispose }
}

export function focusAcceptedTerminalPane(tabId: string, leafId: string): void {
  const hostId = useAppStore.getState().activeWorkspaceExecutionHostId
  activateTabAndFocusPane(tabId, leafId, {
    canFocus: () => {
      const state = useAppStore.getState()
      return state.activeTabId === tabId && state.activeWorkspaceExecutionHostId === hostId
    }
  })
}
