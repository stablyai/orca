import {
  getOpenFileExecutionHostId,
  hasOpenFileExecutionHostEvidence
} from '@/lib/workspace/ownership/unified-tab-host-ownership'
import type { AppState } from '../../../types'
import type { OpenFile } from '../types/open-file'
import type { Tab } from '../../../../../../shared/tab-types'
import { editorPlacementIndex } from './workspace-editor-files'
import { isEditorTabContentType } from './editor-tab-content-type'

/** Resolve the invoking view independently of the document's execution owner. */
export function editorViewTab(
  state: AppState,
  fileId: string,
  viewId?: string | null
): Tab | undefined {
  const tab = viewId
    ? editorPlacementIndex(state.unifiedTabsByWorktree).tabById.get(viewId)
    : undefined
  if (tab && tab.entityId === fileId && isEditorTabContentType(tab.contentType)) {
    return tab
  }
  const tabs = state.activeWorktreeId
    ? (state.unifiedTabsByWorktree[state.activeWorktreeId] ?? [])
    : []
  const groupId = state.activeWorktreeId
    ? state.activeGroupIdByWorktree[state.activeWorktreeId]
    : undefined
  return (
    tabs.find(
      (tab) =>
        tab.entityId === fileId &&
        tab.groupId === groupId &&
        isEditorTabContentType(tab.contentType)
    ) ?? tabs.find((tab) => tab.entityId === fileId && isEditorTabContentType(tab.contentType))
  )
}

export function editorViewPlacement(state: AppState, file: OpenFile, viewId?: string | null) {
  const tab = editorViewTab(state, file.id, viewId)
  return {
    placementWorkspaceId: tab?.worktreeId ?? file.worktreeId,
    targetGroupId: tab?.groupId,
    executionHostId: hasOpenFileExecutionHostEvidence(file)
      ? getOpenFileExecutionHostId(file)
      : undefined
  }
}
