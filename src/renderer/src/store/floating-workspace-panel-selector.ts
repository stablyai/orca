import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { TerminalTab } from '../../../shared/terminal-tab-types'
import type { AppState } from './types'
import { isLiveSurfaceContentType } from '../../../shared/tab-types'

export type FloatingWorkspacePanelVisibilityState = Pick<
  AppState,
  'settings' | 'floatingWorkspacePanelOpen'
>

type FloatingVisibleTabCountState = Pick<
  AppState,
  'browserTabsByWorktree' | 'openFiles' | 'tabsByWorktree' | 'unifiedTabsByWorktree'
>
export type EmptyFloatingWorkspacePanelState = FloatingWorkspacePanelVisibilityState &
  FloatingVisibleTabCountState
type FloatingVisibleTabCountCache = {
  terminalTabs: NonNullable<AppState['tabsByWorktree'][string]>
  browserTabs: NonNullable<AppState['browserTabsByWorktree'][string]>
  openFiles: AppState['openFiles']
  unifiedTabs: NonNullable<AppState['unifiedTabsByWorktree'][string]>
  count: number
}

const EMPTY_TABS: TerminalTab[] = []
const EMPTY_BROWSER_TABS: NonNullable<AppState['browserTabsByWorktree'][string]> = []
const EMPTY_UNIFIED_TABS: NonNullable<AppState['unifiedTabsByWorktree'][string]> = []

let floatingVisibleTabCountCache: FloatingVisibleTabCountCache | null = null

/** Panel is visible only with feature enabled and panel open; closed panels are aria-hidden. */
export function selectFloatingWorkspacePanelVisible(
  state: FloatingWorkspacePanelVisibilityState
): boolean {
  return state.settings?.floatingTerminalEnabled === true && state.floatingWorkspacePanelOpen
}

export function selectFloatingVisibleTabCount(state: FloatingVisibleTabCountState): number {
  const terminalTabs = state.tabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_TABS
  const browserTabs =
    state.browserTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_BROWSER_TABS
  const unifiedTabs =
    state.unifiedTabsByWorktree[FLOATING_TERMINAL_WORKTREE_ID] ?? EMPTY_UNIFIED_TABS
  const cached = floatingVisibleTabCountCache
  if (
    cached &&
    cached.terminalTabs === terminalTabs &&
    cached.browserTabs === browserTabs &&
    cached.openFiles === state.openFiles &&
    cached.unifiedTabs === unifiedTabs
  ) {
    return cached.count
  }

  const terminalIds = new Set<string>()
  for (const tab of terminalTabs) {
    terminalIds.add(tab.id)
  }
  const browserIds = new Set<string>()
  for (const tab of browserTabs) {
    browserIds.add(tab.id)
  }
  const editorIds = new Set<string>()
  for (const file of state.openFiles) {
    if (file.worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
      editorIds.add(file.id)
    }
  }

  let count = 0
  for (const tab of unifiedTabs) {
    if (tab.contentType === 'terminal') {
      count += terminalIds.has(tab.entityId) ? 1 : 0
    } else if (tab.contentType === 'browser') {
      count += browserIds.has(tab.entityId) ? 1 : 0
    } else if (isLiveSurfaceContentType(tab.contentType) || tab.contentType === 'agent-session') {
      // Live-surface/structured-chat tabs have no backing records; unified tabs are the visible floating items.
      count += 1
    } else {
      count += editorIds.has(tab.entityId) ? 1 : 0
    }
  }

  floatingVisibleTabCountCache = {
    terminalTabs,
    browserTabs,
    openFiles: state.openFiles,
    unifiedTabs,
    count
  }
  return count
}

export function resetFloatingVisibleTabCountSelectorCacheForTest(): void {
  floatingVisibleTabCountCache = null
}

export function selectEmptyFloatingWorkspacePanelVisible(
  state: EmptyFloatingWorkspacePanelState
): boolean {
  return selectFloatingWorkspacePanelVisible(state) && selectFloatingVisibleTabCount(state) === 0
}
