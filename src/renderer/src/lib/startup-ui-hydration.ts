import {
  DEFAULT_STATUS_BAR_ITEMS,
  DEFAULT_WORKTREE_CARD_PROPERTIES
} from '../../../shared/constants'
import type { PersistedUIState } from '../../../shared/types'

export function hydratePersistedUIAfterStartupRead({
  persistedUI,
  cancelled,
  hydratePersistedUI
}: {
  persistedUI: PersistedUIState
  cancelled: boolean
  hydratePersistedUI: (ui: PersistedUIState) => void
}): boolean {
  if (cancelled) {
    return false
  }

  hydratePersistedUI(persistedUI)
  return true
}

export function getStartupErrorFallbackUI(uiHydrated: boolean): PersistedUIState | undefined {
  if (uiHydrated) {
    return undefined
  }

  // Why (issue #1158): the app shell still needs persistedUIReady=true when
  // startup fails before ui.get(), but these defaults must never replace a
  // successfully loaded UI snapshot after a later session hydration failure.
  return {
    lastActiveRepoId: null,
    lastActiveWorktreeId: null,
    sidebarWidth: 280,
    rightSidebarWidth: 350,
    groupBy: 'none',
    sortBy: 'name',
    showActiveOnly: false,
    hideDefaultBranchWorkspace: false,
    filterRepoIds: [],
    collapsedGroups: [],
    uiZoomLevel: 0,
    editorFontZoomLevel: 0,
    worktreeCardProperties: [...DEFAULT_WORKTREE_CARD_PROPERTIES],
    statusBarItems: [...DEFAULT_STATUS_BAR_ITEMS],
    statusBarVisible: true,
    dismissedUpdateVersion: null,
    lastUpdateCheckAt: null
  }
}
