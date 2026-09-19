import type { AppState } from '../../types'
import { toVisibleTabType } from '../../../../../shared/tab-types'
import type { WorkspaceVisibleTabType } from '../../../../../shared/tab-types'

export type ActiveSurfaceSourceState = Pick<
  AppState,
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeGroupIdByWorktree'
  | 'activeTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'browserTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'openFiles'
  | 'tabsByWorktree'
  | 'unifiedTabsByWorktree'
>

export function deriveActiveSurfaceForWorktree(
  state: ActiveSurfaceSourceState,
  worktreeId: string,
  preferredGroupId?: string | null,
  options?: { preferredTabId?: string; legacySelection?: 'remembered-type' }
): {
  activeBrowserTabId: string | null
  activeFileId: string | null
  activeTabId: string | null
  activeTabType: WorkspaceVisibleTabType
} {
  const groups = state.groupsByWorktree[worktreeId] ?? []
  const activeGroupId = preferredGroupId ?? state.activeGroupIdByWorktree[worktreeId] ?? null
  const activeGroup =
    (activeGroupId ? groups.find((group) => group.id === activeGroupId) : null) ?? groups[0] ?? null
  const activeUnifiedTabId = options?.preferredTabId ?? activeGroup?.activeTabId
  const activeUnifiedTab =
    activeUnifiedTabId != null
      ? ((state.unifiedTabsByWorktree[worktreeId] ?? []).find(
          (tab) =>
            tab.id === activeUnifiedTabId && activeGroup != null && tab.groupId === activeGroup.id
        ) ?? null)
      : null
  const restoredFileId = state.activeFileIdByWorktree[worktreeId] ?? null
  const restoredBrowserTabId = state.activeBrowserTabIdByWorktree[worktreeId] ?? null
  const restoredTerminalTabId = state.activeTabIdByWorktree[worktreeId] ?? null
  const browserTabs = state.browserTabsByWorktree[worktreeId] ?? []
  const terminalTabs = state.tabsByWorktree[worktreeId] ?? []
  const fileStillOpen = restoredFileId
    ? state.openFiles.some((file) => file.id === restoredFileId && file.worktreeId === worktreeId)
    : false
  const browserTabStillOpen = restoredBrowserTabId
    ? browserTabs.some((tab) => tab.id === restoredBrowserTabId)
    : false
  const terminalTabStillExists = restoredTerminalTabId
    ? terminalTabs.some((tab) => tab.id === restoredTerminalTabId)
    : false
  const hasGroupOwnedSurface = groups.length > 0 || Boolean(state.layoutByWorktree[worktreeId])

  const restoreLegacyType = options?.legacySelection === 'remembered-type'
  const restoredTabType = restoreLegacyType
    ? (state.activeTabTypeByWorktree[worktreeId] ?? 'terminal')
    : null
  // Why: only a remembered browser type — or group focus, which remembers no type at all — may keep
  // the remembered file selected under the browser surface; a stale agent-session/simulator clears it.
  const keepRememberedFileUnderBrowser = restoredTabType === null || restoredTabType === 'browser'

  let activeFileId: string | null
  let activeBrowserTabId: string | null
  let activeTabType: WorkspaceVisibleTabType

  if (activeUnifiedTab) {
    activeFileId =
      activeUnifiedTab.contentType === 'editor' ||
      activeUnifiedTab.contentType === 'diff' ||
      activeUnifiedTab.contentType === 'conflict-review' ||
      activeUnifiedTab.contentType === 'check-details'
        ? activeUnifiedTab.entityId
        : fileStillOpen
          ? restoredFileId
          : null
    activeBrowserTabId =
      activeUnifiedTab.contentType === 'browser'
        ? activeUnifiedTab.entityId
        : browserTabStillOpen
          ? restoredBrowserTabId
          : (browserTabs[0]?.id ?? null)
    activeTabType = toVisibleTabType(activeUnifiedTab.contentType)
  } else if (hasGroupOwnedSurface) {
    activeFileId = fileStillOpen ? restoredFileId : null
    activeBrowserTabId = browserTabStillOpen ? restoredBrowserTabId : (browserTabs[0]?.id ?? null)
    // Why: focusing an empty split should target its default terminal area, not the previously active browser/editor in another group.
    activeTabType = 'terminal'
  } else if (restoredTabType === 'terminal') {
    activeFileId = fileStillOpen ? restoredFileId : null
    activeBrowserTabId = browserTabStillOpen ? restoredBrowserTabId : (browserTabs[0]?.id ?? null)
    activeTabType = 'terminal'
  } else if (restoredTabType === 'editor' && fileStillOpen) {
    activeFileId = restoredFileId
    activeBrowserTabId = browserTabStillOpen ? restoredBrowserTabId : (browserTabs[0]?.id ?? null)
    activeTabType = 'editor'
  } else if (browserTabStillOpen) {
    activeFileId = keepRememberedFileUnderBrowser && fileStillOpen ? restoredFileId : null
    activeBrowserTabId = restoredBrowserTabId
    activeTabType = 'browser'
  } else if (fileStillOpen) {
    activeFileId = restoredFileId
    activeBrowserTabId = browserTabs[0]?.id ?? null
    activeTabType = 'editor'
  } else {
    const fallbackFile = state.openFiles.find((file) => file.worktreeId === worktreeId) ?? null
    const fallbackBrowserTab = browserTabs[0] ?? null
    activeFileId = fallbackFile?.id ?? null
    activeBrowserTabId = fallbackBrowserTab?.id ?? null
    activeTabType = fallbackFile ? 'editor' : fallbackBrowserTab ? 'browser' : 'terminal'
  }

  return {
    activeBrowserTabId,
    activeFileId,
    activeTabId:
      activeUnifiedTab?.contentType === 'terminal'
        ? activeUnifiedTab.entityId
        : terminalTabStillExists
          ? restoredTerminalTabId
          : (terminalTabs[0]?.id ?? null),
    activeTabType
  }
}

export function buildActiveSurfacePatch(
  state: ActiveSurfaceSourceState,
  worktreeId: string,
  preferredGroupId?: string | null
): Pick<
  AppState,
  | 'activeBrowserTabId'
  | 'activeBrowserTabIdByWorktree'
  | 'activeFileId'
  | 'activeFileIdByWorktree'
  | 'activeTabId'
  | 'activeTabIdByWorktree'
  | 'activeTabType'
  | 'activeTabTypeByWorktree'
> {
  const derived = deriveActiveSurfaceForWorktree(state, worktreeId, preferredGroupId)
  return {
    activeBrowserTabId: derived.activeBrowserTabId,
    activeBrowserTabIdByWorktree: {
      ...state.activeBrowserTabIdByWorktree,
      [worktreeId]: derived.activeBrowserTabId
    },
    activeFileId: derived.activeFileId,
    activeFileIdByWorktree: {
      ...state.activeFileIdByWorktree,
      [worktreeId]: derived.activeFileId
    },
    activeTabId: derived.activeTabId,
    activeTabIdByWorktree: {
      ...state.activeTabIdByWorktree,
      [worktreeId]: derived.activeTabId
    },
    activeTabType: derived.activeTabType,
    activeTabTypeByWorktree: {
      ...state.activeTabTypeByWorktree,
      [worktreeId]: derived.activeTabType
    }
  }
}

export function activeSurfacePatchMatchesState(
  state: Pick<
    AppState,
    | 'activeBrowserTabId'
    | 'activeBrowserTabIdByWorktree'
    | 'activeFileId'
    | 'activeFileIdByWorktree'
    | 'activeTabId'
    | 'activeTabIdByWorktree'
    | 'activeTabType'
    | 'activeTabTypeByWorktree'
  >,
  worktreeId: string,
  patch: Pick<
    AppState,
    | 'activeBrowserTabId'
    | 'activeBrowserTabIdByWorktree'
    | 'activeFileId'
    | 'activeFileIdByWorktree'
    | 'activeTabId'
    | 'activeTabIdByWorktree'
    | 'activeTabType'
    | 'activeTabTypeByWorktree'
  >
): boolean {
  return (
    state.activeBrowserTabId === patch.activeBrowserTabId &&
    state.activeBrowserTabIdByWorktree[worktreeId] ===
      patch.activeBrowserTabIdByWorktree[worktreeId] &&
    state.activeFileId === patch.activeFileId &&
    state.activeFileIdByWorktree[worktreeId] === patch.activeFileIdByWorktree[worktreeId] &&
    state.activeTabId === patch.activeTabId &&
    state.activeTabIdByWorktree[worktreeId] === patch.activeTabIdByWorktree[worktreeId] &&
    state.activeTabType === patch.activeTabType &&
    state.activeTabTypeByWorktree[worktreeId] === patch.activeTabTypeByWorktree[worktreeId]
  )
}
