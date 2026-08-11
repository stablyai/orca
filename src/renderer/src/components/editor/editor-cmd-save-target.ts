import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Tab, TabContentType, TopLevelView } from '../../../../shared/types'

export const EDITOR_TAB_CONTENT_TYPES = new Set<TabContentType>([
  'editor',
  'diff',
  'conflict-review',
  'check-details'
])

type EditorCmdSaveState = {
  activeFileId: string | null
  activeTabType: string | null
  activeView: TopLevelView
  getActiveTab: (worktreeId: string) => Tab | null
}

export function getEditorCmdSaveFileId(
  state: EditorCmdSaveState,
  floatingPanelOwnsEvent: boolean
): string | null {
  if (!floatingPanelOwnsEvent) {
    // Why: outside the workspace view no mounted panel claims the request, so
    // returning an id would swallow Cmd/Ctrl+S on Tasks/Settings without saving.
    // The floating panel floats above every view and keeps its own ownership.
    return state.activeView === 'terminal' && state.activeTabType === 'editor'
      ? state.activeFileId
      : null
  }
  const activeTab = state.getActiveTab(FLOATING_TERMINAL_WORKTREE_ID)
  return activeTab && EDITOR_TAB_CONTENT_TYPES.has(activeTab.contentType)
    ? activeTab.entityId
    : null
}
