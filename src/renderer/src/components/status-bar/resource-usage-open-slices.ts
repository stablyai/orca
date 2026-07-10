import type { AppState } from '../../store'
import { getAllWorktreesFromState } from '../../store/selectors'

const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_PTY_IDS_BY_TAB_ID: AppState['ptyIdsByTabId'] = {}
const EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID: AppState['terminalLayoutsByTabId'] = {}
const EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID: AppState['runtimePaneTitlesByTabId'] = {}
const EMPTY_REPOS: AppState['repos'] = []
const EMPTY_WORKTREES: ReturnType<typeof getAllWorktreesFromState> = []

export function getResourceUsageTabsByWorktree(
  state: Pick<AppState, 'tabsByWorktree'>,
  open: boolean
): AppState['tabsByWorktree'] {
  return open ? state.tabsByWorktree : EMPTY_TABS_BY_WORKTREE
}

export function getResourceUsagePtyIdsByTabId(
  state: Pick<AppState, 'ptyIdsByTabId'>,
  open: boolean
): AppState['ptyIdsByTabId'] {
  return open ? state.ptyIdsByTabId : EMPTY_PTY_IDS_BY_TAB_ID
}

export function getResourceUsageTerminalLayoutsByTabId(
  state: Pick<AppState, 'terminalLayoutsByTabId'>,
  open: boolean
): AppState['terminalLayoutsByTabId'] {
  return open ? state.terminalLayoutsByTabId : EMPTY_TERMINAL_LAYOUTS_BY_TAB_ID
}

export function getResourceUsageRuntimePaneTitlesByTabId(
  state: Pick<AppState, 'runtimePaneTitlesByTabId'>,
  open: boolean
): AppState['runtimePaneTitlesByTabId'] {
  return open ? state.runtimePaneTitlesByTabId : EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID
}

export function getResourceUsageRepos(
  state: Pick<AppState, 'repos'>,
  open: boolean
): AppState['repos'] {
  return open ? state.repos : EMPTY_REPOS
}

export function getResourceUsageAllWorktrees(
  state: Pick<AppState, 'worktreesByRepo'>,
  open: boolean
): ReturnType<typeof getAllWorktreesFromState> {
  return open ? getAllWorktreesFromState(state) : EMPTY_WORKTREES
}
