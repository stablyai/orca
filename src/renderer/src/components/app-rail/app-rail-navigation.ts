import type { UISlice } from '@/store/slices/ui/ui-slice-contract'
import type { AppState } from '@/store/types'
import { useAppStore } from '@/store/index'
import { leaveSettingsThen } from '@/components/settings/page/settings-leave-guard'
import { isLiveEntry, isViewEntry } from '@/store/slices/ui/workspace-navigation-history'

type PageCloseActions = Pick<
  UISlice,
  | 'closeCommanderPage'
  | 'closeTaskPage'
  | 'closeAutomationsPage'
  | 'closeArtifactsPage'
  | 'closeSkillsPage'
  | 'closeSettingsPage'
  | 'closeActivityPage'
  | 'closeSpacePage'
  | 'closeMobilePage'
>

/** The store API the rail navigates through (the real `useAppStore`, or a fake in tests). */
export type RailNavigationStore = {
  getState: () => AppState
  setState: (partial: Pick<AppState, 'worktreeNavHistoryIndex'>) => void
}

const CLOSE_PAGE: Record<Exclude<UISlice['activeView'], 'terminal'>, keyof PageCloseActions> = {
  commander: 'closeCommanderPage',
  tasks: 'closeTaskPage',
  automations: 'closeAutomationsPage',
  artifacts: 'closeArtifactsPage',
  skills: 'closeSkillsPage',
  settings: 'closeSettingsPage',
  activity: 'closeActivityPage',
  space: 'closeSpacePage',
  mobile: 'closeMobilePage'
}

/** Nearest earlier entry that is a live workspace (folder workspaces included), never a page view. */
function findPrevLiveWorkspaceHistoryIndex(state: AppState): number | null {
  for (let i = state.worktreeNavHistoryIndex - 1; i >= 0; i--) {
    const entry = state.worktreeNavHistory[i]
    if (!isViewEntry(entry) && isLiveEntry(entry, state)) {
      return i
    }
  }
  return null
}

/**
 * Leave every open page for the terminal: each page's own close runs at most once (its cleanup and history
 * rewind), then the cursor settles on the nearest earlier live workspace so Back/Forward match the terminal.
 */
export function returnToTerminalView(store: RailNavigationStore): void {
  const { getState } = store
  const closed = new Set<UISlice['activeView']>()
  let view = getState().activeView
  if (view === 'terminal') {
    return
  }
  while (view !== 'terminal' && !closed.has(view)) {
    closed.add(view)
    getState()[CLOSE_PAGE[view]]()
    view = getState().activeView
  }
  // Only a stale or cyclic previous-view chain gets here, after every page in it has already closed once.
  if (view !== 'terminal') {
    getState().setActiveView('terminal')
  }
  const state = getState()
  if (isViewEntry(state.worktreeNavHistory[state.worktreeNavHistoryIndex])) {
    const index = findPrevLiveWorkspaceHistoryIndex(state)
    if (index !== null) {
      store.setState({ worktreeNavHistoryIndex: index })
    }
  }
}

export function isWorkspacesRailItemActive(
  state: Pick<UISlice, 'activeView' | 'sidebarBody'>
): boolean {
  return state.activeView === 'terminal' && (state.sidebarBody ?? 'workspaces') === 'workspaces'
}

/** Re-clicking an active Workspaces toggles the list; from anywhere else it returns to the list and never collapses it. */
export function activateWorkspacesRailItem(store: RailNavigationStore): void {
  const { getState } = store
  if (isWorkspacesRailItemActive(getState())) {
    getState().toggleSidebar()
    return
  }
  returnToTerminalView(store)
  getState().setSidebarBody('workspaces')
  if (!getState().sidebarOpen) {
    getState().setSidebarOpen(true)
  }
}

/** Every rail exit from Settings goes through Settings' discard check; Cancel leaves everything as it was. */
export function navigateFromRail(intent: () => void): void {
  void leaveSettingsThen(() => useAppStore.getState().activeView === 'settings', intent)
}
