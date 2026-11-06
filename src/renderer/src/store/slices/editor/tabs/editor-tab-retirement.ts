import type { Tab } from '../../../../../../shared/tab-types'
import type { AppState } from '../../../types'
import type { EditorSet, EditorGet } from '../types/editor-set-get'
import { getRecentlyClosedTabPosition, pushRecentlyClosedTabKind } from '../../recently-closed-tabs'
import { MAX_RECENT_CLOSED_EDITOR_TABS } from '../types/open-file'
import { isEditorTabContentType } from './editor-tab-content-type'
import { editorContentIsReferenced } from './workspace-editor-files'

/** Capture a view before its group disappears; content can survive in another workspace. */
export function editorTabRetirement(set: EditorSet, get: EditorGet, before: AppState, tab: Tab) {
  const file = isEditorTabContentType(tab.contentType)
    ? before.openFiles.find((entry) => entry.id === tab.entityId)
    : undefined
  const position = file ? getRecentlyClosedTabPosition(before, tab.worktreeId, file.id) : undefined
  return () => {
    if (
      !file ||
      get().unifiedTabsByWorktree[tab.worktreeId]?.some((entry) => entry.id === tab.id)
    ) {
      return
    }
    if (
      file.mode !== 'markdown-preview' &&
      !(file.isUntitled && !file.isDirty && !before.editorDrafts[file.id])
    ) {
      const { id, isDirty: _dirty, mirroredFromRuntimeSession: _mirrored, ...snapshot } = file
      set((state) => ({
        recentlyClosedEditorTabsByWorktree: {
          ...state.recentlyClosedEditorTabsByWorktree,
          [tab.worktreeId]: [
            { ...snapshot, reopenId: id, ...(position ? { position } : {}) },
            ...(state.recentlyClosedEditorTabsByWorktree[tab.worktreeId] ?? [])
          ].slice(0, MAX_RECENT_CLOSED_EDITOR_TABS)
        },
        recentlyClosedTabKindsByWorktree: pushRecentlyClosedTabKind(
          state.recentlyClosedTabKindsByWorktree,
          tab.worktreeId,
          'editor'
        )
      }))
    }
    releaseUnreferencedEditorContent(get, file.id)
  }
}

export function releaseUnreferencedEditorContent(get: EditorGet, entityId: string): void {
  if (!editorContentIsReferenced(get(), entityId)) {
    get().closeFile(entityId, { captureRecentlyClosed: false })
  }
}
