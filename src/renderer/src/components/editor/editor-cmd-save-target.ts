import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Tab } from '../../../../shared/tab-types'
import { effectiveWorkspaceView, type RendererView } from '@/lib/renderer-view'
import { isEditorTabContentType } from '@/store/slices/editor/tabs/editor-tab-content-type'

type EditorCmdSaveState = {
  activeFileId: string | null
  activeTabType: string | null
  activeView: RendererView
  settings?: { experimentalThreads?: boolean } | null
  getActiveTab: (worktreeId: string) => Tab | null
}

export function getEditorCmdSaveFileId(
  state: EditorCmdSaveState,
  floatingPanelOwnsEvent: boolean
): string | null {
  if (!floatingPanelOwnsEvent) {
    // Only mounted workspace editors claim saves; floating panels retain ownership above other views so Tasks/Settings cannot swallow Cmd/Ctrl+S.
    return effectiveWorkspaceView(state) === 'terminal' && state.activeTabType === 'editor'
      ? state.activeFileId
      : null
  }
  const activeTab = state.getActiveTab(FLOATING_TERMINAL_WORKTREE_ID)
  return activeTab && isEditorTabContentType(activeTab.contentType) ? activeTab.entityId : null
}
