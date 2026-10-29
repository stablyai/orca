import type { OrdinarySourcePartial } from '../../store/session-source-edits'
import type { WebSessionTabsSyncState } from './state'

/** Keyed mirror values belong to the operation edit; this return carries only other state. */
export function webSessionTabsNonSourcePatch(
  patch: Partial<WebSessionTabsSyncState>
): OrdinarySourcePartial<WebSessionTabsSyncState> {
  const {
    tabsByWorktree: _tabs,
    ptyIdsByTabId: _ptys,
    terminalLayoutsByTabId: _terminalLayouts,
    localOnlyScrollbackByTabId: _scrollback,
    activeTabIdByWorktree: _activeTabs,
    openFiles: _files,
    editorDrafts: _drafts,
    activeFileIdByWorktree: _activeFiles,
    activeTabTypeByWorktree: _activeTypes,
    browserTabsByWorktree: _browserTabs,
    browserPagesByWorkspace: _browserPages,
    activeBrowserTabIdByWorktree: _activeBrowser,
    remoteBrowserPageHandlesByPageId: _handles,
    unifiedTabsByWorktree: _unified,
    groupsByWorktree: _groups,
    layoutByWorktree: _layouts,
    activeGroupIdByWorktree: _activeGroups,
    ...other
  } = patch
  return other
}
