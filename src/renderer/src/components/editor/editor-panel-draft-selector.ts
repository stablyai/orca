import type { AppState } from '@/store'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'
import {
  conflictOverviewView,
  type ConflictOverviewState
} from '@/store/slices/editor/buffers/editor-buffer-conflict-overview'

type EditorDraftState = Pick<AppState, 'editorDrafts'> & ConflictOverviewState
type EditorPanelDraftSelector = (state: EditorDraftState) => Record<string, string>

const EMPTY_EDITOR_PANEL_DRAFTS = Object.freeze({}) as Record<string, string>

export function createEditorPanelDraftSelector(
  activeFile: OpenFile | null
): EditorPanelDraftSelector {
  // Include related preview/conflict files without subscribing this editor to unrelated panels’ typing.
  const fileIds = activeFile
    ? [
        activeFile.id,
        activeFile.markdownPreviewSourceFileId,
        activeFile.conflictReview?.selectedFileId
      ].filter((fileId): fileId is string => Boolean(fileId))
    : []
  const overviewPaths =
    activeFile?.mode === 'conflict-review' && !activeFile.conflictReview?.selectedFileId
      ? (activeFile.conflictReview?.entries ?? []).map((entry) =>
          joinPath(activeFile.filePath, entry.path)
        )
      : []
  // Resolve overview drafts through record view IDs; server file IDs need not equal paths.
  const selectedFileIds = (state: EditorDraftState): string[] =>
    overviewPaths.length === 0 || !activeFile
      ? fileIds
      : Array.from(
          new Set([
            ...fileIds,
            ...overviewPaths.map(
              (path) => conflictOverviewView(state, activeFile.worktreeId, path)?.id ?? path
            )
          ])
        )
  let previousDrafts: AppState['editorDrafts'] | null = null
  let previousOpenFiles: EditorDraftState['openFiles'] | null = null
  let previousViews: EditorDraftState['editorBufferViews'] | null = null
  let previousSelection = EMPTY_EDITOR_PANEL_DRAFTS

  return (state) => {
    // Guard slice identities so terminal/status writes allocate nothing; overview IDs also depend on current tabs and record views.
    if (
      previousDrafts === state.editorDrafts &&
      (overviewPaths.length === 0 ||
        (previousOpenFiles === state.openFiles && previousViews === state.editorBufferViews))
    ) {
      return previousSelection
    }
    previousDrafts = state.editorDrafts
    previousOpenFiles = state.openFiles
    previousViews = state.editorBufferViews

    const ids = selectedFileIds(state)
    const idSet = new Set(ids)
    const changed =
      ids.some((fileId) => {
        const draft = state.editorDrafts[fileId]
        return (
          draft !== previousSelection[fileId] ||
          (draft === undefined && Object.hasOwn(previousSelection, fileId))
        )
      }) || Object.keys(previousSelection).some((fileId) => !idSet.has(fileId))
    if (!changed) {
      return previousSelection
    }

    const nextSelection: Record<string, string> = {}
    for (const fileId of ids) {
      const draft = state.editorDrafts[fileId]
      if (draft !== undefined) {
        nextSelection[fileId] = draft
      }
    }
    previousSelection = nextSelection
    return previousSelection
  }
}
