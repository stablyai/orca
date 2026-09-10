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

// Why: every Zustand write reruns this app-shell selector, including title-only tab updates.
let activeTerminalChromeCache: ActiveTerminalChromeState | null = null

export function selectActiveTerminalChromeState(
  state: ActiveTerminalChromeSelectorState
): ActiveTerminalChromeState {
  const tabs = state.activeWorktreeId
    ? (state.tabsByWorktree[state.activeWorktreeId] ?? EMPTY_TABS)
    : EMPTY_TABS
  const effectiveActiveTabId = state.activeTabId ?? tabs[0]?.id ?? null
  const activeTabCanExpand = effectiveActiveTabId
    ? (state.canExpandPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const effectiveActiveTabExpanded = effectiveActiveTabId
    ? (state.expandedPaneByTabId[effectiveActiveTabId] ?? false)
    : false
  const cached = activeTerminalChromeCache
  if (
    cached &&
    cached.activeWorktreeId === state.activeWorktreeId &&
    cached.activeTabId === state.activeTabId &&
    cached.tabCount === tabs.length &&
    cached.effectiveActiveTabId === effectiveActiveTabId &&
    cached.activeTabCanExpand === activeTabCanExpand &&
    cached.effectiveActiveTabExpanded === effectiveActiveTabExpanded
  ) {
    return cached
  }

  const selected: ActiveTerminalChromeState = {
    activeWorktreeId: state.activeWorktreeId,
    activeTabId: state.activeTabId,
    tabCount: tabs.length,
    effectiveActiveTabId,
    activeTabCanExpand,
    effectiveActiveTabExpanded
  }
  activeTerminalChromeCache = selected
  return selected
}

export function resetActiveTerminalChromeStateSelectorCacheForTest(): void {
  activeTerminalChromeCache = null
}
