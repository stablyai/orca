import type { AppState } from '../../store'
import { getAllWorktreesFromState } from '../../store/selectors'

const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID: AppState['runtimePaneTitlesByTabId'] = {}
const EMPTY_REPOS: AppState['repos'] = []
const EMPTY_WORKTREES: ReturnType<typeof getAllWorktreesFromState> = []

function shouldReadPopoverSlices(open: boolean, runtimeEnvironmentActive: boolean): boolean {
  return open && !runtimeEnvironmentActive
}

export function getResourceUsageTabsByWorktree(
  state: Pick<AppState, 'tabsByWorktree'>,
  open: boolean,
  runtimeEnvironmentActive = false
): AppState['tabsByWorktree'] {
  return shouldReadPopoverSlices(open, runtimeEnvironmentActive)
    ? state.tabsByWorktree
    : EMPTY_TABS_BY_WORKTREE
}

export function getResourceUsageRuntimePaneTitlesByTabId(
  state: Pick<AppState, 'runtimePaneTitlesByTabId'>,
  open: boolean,
  runtimeEnvironmentActive = false
): AppState['runtimePaneTitlesByTabId'] {
  return shouldReadPopoverSlices(open, runtimeEnvironmentActive)
    ? state.runtimePaneTitlesByTabId
    : EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID
}

export function getResourceUsageRepos(
  state: Pick<AppState, 'repos'>,
  open: boolean,
  runtimeEnvironmentActive: boolean
): AppState['repos'] {
  return shouldReadPopoverSlices(open, runtimeEnvironmentActive) ? state.repos : EMPTY_REPOS
}

export function getResourceUsageAllWorktrees(
  state: Pick<AppState, 'worktreesByRepo'>,
  open: boolean,
  runtimeEnvironmentActive: boolean
): ReturnType<typeof getAllWorktreesFromState> {
  return shouldReadPopoverSlices(open, runtimeEnvironmentActive)
    ? getAllWorktreesFromState(state)
    : EMPTY_WORKTREES
}
