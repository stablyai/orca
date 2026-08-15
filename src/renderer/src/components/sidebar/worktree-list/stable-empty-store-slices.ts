import type { AppState } from '@/store/types'

// Why: selectors that opt out of a slice must return one stable reference, or every store tick looks like a change.
export const EMPTY_AGENT_STATUS_BY_PANE_KEY: AppState['agentStatusByPaneKey'] = {}
export const EMPTY_WORKTREE_ID_SET: ReadonlySet<string> = new Set()
export const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
export const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: AppState['terminalLayoutsByTabId'] = {}
export const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
export const EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID: AppState['runtimePaneTitlesByTabId'] = {}
