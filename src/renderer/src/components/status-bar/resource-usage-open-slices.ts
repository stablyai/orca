import type { AppState } from '../../store'
import { getAllWorktreesFromState } from '../../store/selectors'

const EMPTY_TABS_BY_WORKTREE: AppState['tabsByWorktree'] = {}
const EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID: AppState['runtimePaneTitlesByTabId'] = {}
const EMPTY_REPOS: AppState['repos'] = []
const EMPTY_WORKTREES: ReturnType<typeof getAllWorktreesFromState> = []

function shouldReadPopoverSlices(open: boolean): boolean {
  return open
}

export function getResourceUsageTabsByWorktree(
  state: Pick<AppState, 'tabsByWorktree'>,
  open: boolean
): AppState['tabsByWorktree'] {
  return shouldReadPopoverSlices(open) ? state.tabsByWorktree : EMPTY_TABS_BY_WORKTREE
}

export function getResourceUsageRuntimePaneTitlesByTabId(
  state: Pick<AppState, 'runtimePaneTitlesByTabId'>,
  open: boolean
): AppState['runtimePaneTitlesByTabId'] {
  return shouldReadPopoverSlices(open)
    ? state.runtimePaneTitlesByTabId
    : EMPTY_RUNTIME_PANE_TITLES_BY_TAB_ID
}

export function getResourceUsageRepos(
  state: Pick<AppState, 'repos'>,
  open: boolean
): AppState['repos'] {
  return shouldReadPopoverSlices(open) ? state.repos : EMPTY_REPOS
}

export function getResourceUsageAllWorktrees(
  state: Pick<AppState, 'worktreesByRepo'>,
  open: boolean
): ReturnType<typeof getAllWorktreesFromState> {
  return shouldReadPopoverSlices(open) ? getAllWorktreesFromState(state) : EMPTY_WORKTREES
}
