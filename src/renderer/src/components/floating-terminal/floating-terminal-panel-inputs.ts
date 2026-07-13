import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'

type FloatingTerminalPanelState = Pick<
  AppState,
  | 'browserTabsByWorktree'
  | 'expandedPaneByTabId'
  | 'groupsByWorktree'
  | 'openFiles'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

export type FloatingTerminalPanelInputs = {
  browserTabs: NonNullable<AppState['browserTabsByWorktree'][string]>
  expandedPaneByTabId: Record<string, boolean>
  floatingFiles: AppState['openFiles']
  groups: NonNullable<AppState['groupsByWorktree'][string]>
  tabs: NonNullable<AppState['tabsByWorktree'][string]>
  unifiedTabs: NonNullable<AppState['unifiedTabsByWorktree'][string]>
}

type SelectorDependencies = {
  onExpandedTabVisited?: (tabId: string) => void
  onOpenFileVisited?: (fileId: string) => void
}

const EMPTY_BROWSER_TABS: FloatingTerminalPanelInputs['browserTabs'] = []
const EMPTY_EXPANDED_PANES: FloatingTerminalPanelInputs['expandedPaneByTabId'] = {}
const EMPTY_FILES: FloatingTerminalPanelInputs['floatingFiles'] = []
const EMPTY_GROUPS: FloatingTerminalPanelInputs['groups'] = []
const EMPTY_TABS: FloatingTerminalPanelInputs['tabs'] = []
const EMPTY_UNIFIED_TABS: FloatingTerminalPanelInputs['unifiedTabs'] = []

function reuseArrayIfEqual<T>(previous: T[], next: T[]): T[] {
  return previous.length === next.length && next.every((value, index) => previous[index] === value)
    ? previous
    : next
}

function reuseExpandedPanesIfEqual(
  previous: Record<string, boolean>,
  next: Record<string, boolean>
): Record<string, boolean> {
  const nextKeys = Object.keys(next)
  if (Object.keys(previous).length !== nextKeys.length) {
    return next
  }
  return nextKeys.every((key) => previous[key] === next[key]) ? previous : next
}

export function createFloatingTerminalPanelInputsSelector(
  dependencies: SelectorDependencies = {}
): (state: FloatingTerminalPanelState) => FloatingTerminalPanelInputs {
  let openFilesSource: AppState['openFiles'] | null = null
  let floatingFiles = EMPTY_FILES
  let expandedTabsSource: FloatingTerminalPanelInputs['tabs'] | null = null
  let expandedPanesSource: AppState['expandedPaneByTabId'] | null = null
  let expandedPaneByTabId = EMPTY_EXPANDED_PANES
  let previous: FloatingTerminalPanelInputs | null = null

  return (state) => {
    const tabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TABS
    const browserTabs =
      state.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_BROWSER_TABS
    const groups = state.groupsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_GROUPS
    const unifiedTabs =
      state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_UNIFIED_TABS

    if (state.openFiles !== openFilesSource) {
      const nextFloatingFiles = [] as AppState['openFiles']
      for (const file of state.openFiles) {
        dependencies.onOpenFileVisited?.(file.id)
        if (file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
          nextFloatingFiles.push(file)
        }
      }
      floatingFiles = reuseArrayIfEqual(floatingFiles, nextFloatingFiles)
      openFilesSource = state.openFiles
    }

    if (tabs !== expandedTabsSource || state.expandedPaneByTabId !== expandedPanesSource) {
      const nextExpandedPaneByTabId: Record<string, boolean> = {}
      for (const tab of tabs) {
        dependencies.onExpandedTabVisited?.(tab.id)
        if (state.expandedPaneByTabId[tab.id] === true) {
          nextExpandedPaneByTabId[tab.id] = true
        }
      }
      expandedPaneByTabId = reuseExpandedPanesIfEqual(expandedPaneByTabId, nextExpandedPaneByTabId)
      expandedTabsSource = tabs
      expandedPanesSource = state.expandedPaneByTabId
    }

    if (
      previous?.tabs === tabs &&
      previous.browserTabs === browserTabs &&
      previous.groups === groups &&
      previous.unifiedTabs === unifiedTabs &&
      previous.floatingFiles === floatingFiles &&
      previous.expandedPaneByTabId === expandedPaneByTabId
    ) {
      return previous
    }

    previous = {
      browserTabs,
      expandedPaneByTabId,
      floatingFiles,
      groups,
      tabs,
      unifiedTabs
    }
    return previous
  }
}

// Why: the closed floating workspace retains its pane tree. Scope its one
// subscription so ordinary workspace writes do not rerender that hidden tree.
export const selectFloatingTerminalPanelInputs = createFloatingTerminalPanelInputsSelector()
