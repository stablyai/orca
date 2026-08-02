import type { AppState } from './types'

type ActiveTerminalChromeSelectorState = Pick<
  AppState,
  | 'activeWorktreeId'
  | 'activeTabId'
  | 'tabsByWorktree'
  | 'canExpandPaneByTabId'
  | 'expandedPaneByTabId'
>

export type ActiveTerminalChromeState = {
  activeWorktreeId: string | null
  activeTabId: string | null
  tabCount: number
  effectiveActiveTabId: string | null
  activeTabCanExpand: boolean
  effectiveActiveTabExpanded: boolean
}

const EMPTY_TABS: NonNullable<AppState['tabsByWorktree'][string]> = []

export function selectActiveTerminalChromeState(
  state: ActiveTerminalChromeSelectorState
): ActiveTerminalChromeState {
  const tabs = state.activeWorktreeId
    ? (state.tabsByWorktree[state.activeWorktreeId] ?? EMPTY_TABS)
    : EMPTY_TABS
  const effectiveActiveTabId = state.activeTabId ?? tabs[0]?.id ?? null
  return {
    activeWorktreeId: state.activeWorktreeId,
    activeTabId: state.activeTabId,
    tabCount: tabs.length,
    effectiveActiveTabId,
    activeTabCanExpand: effectiveActiveTabId
      ? (state.canExpandPaneByTabId[effectiveActiveTabId] ?? false)
      : false,
    effectiveActiveTabExpanded: effectiveActiveTabId
      ? (state.expandedPaneByTabId[effectiveActiveTabId] ?? false)
      : false
  }
}
