import type { AppState } from '@/store'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'

type EditorDraftState = Pick<AppState, 'editorDrafts'>
type EditorPanelDraftSelector = (state: EditorDraftState) => Record<string, string>

const EMPTY_EDITOR_PANEL_DRAFTS = Object.freeze({}) as Record<string, string>

export function createEditorPanelDraftSelector(
  activeFile: OpenFile | null
): EditorPanelDraftSelector {
  // Why: previews and conflict review can render a related file, but drafts
  // from every other panel must not wake this editor on each keystroke.
  const fileIds = activeFile
    ? Array.from(
        new Set(
          [
            activeFile.id,
            activeFile.markdownPreviewSourceFileId,
            activeFile.conflictReview?.selectedFileId,
            ...(activeFile.mode === 'conflict-review' && !activeFile.conflictReview?.selectedFileId
              ? (activeFile.conflictReview?.entries ?? []).map((entry) =>
                  joinPath(activeFile.filePath, entry.path)
                )
              : [])
          ].filter((fileId): fileId is string => Boolean(fileId))
        )
      )
    : []
  let previousDrafts: AppState['editorDrafts'] | null = null
  let previousSelection = EMPTY_EDITOR_PANEL_DRAFTS

  return (state) => {
    // Why: every Zustand write reruns the selector. The slice identity guard
    // keeps unrelated terminal/status traffic allocation-free.
    if (previousDrafts === state.editorDrafts) {
      return previousSelection
    }
    previousDrafts = state.editorDrafts

    const changed = fileIds.some((fileId) => {
      const draft = state.editorDrafts[fileId]
      return (
        draft !== previousSelection[fileId] ||
        (draft === undefined && Object.prototype.hasOwnProperty.call(previousSelection, fileId))
      )
    })
    if (!changed) {
      return previousSelection
    }

    const nextSelection: Record<string, string> = {}
    for (const fileId of fileIds) {
      const draft = state.editorDrafts[fileId]
      if (draft !== undefined) {
        nextSelection[fileId] = draft
      }
    }
    previousSelection = nextSelection
    return previousSelection
  }
}
