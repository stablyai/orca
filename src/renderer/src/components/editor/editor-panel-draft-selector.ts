import type { AppState } from '@/store'
import { joinPath } from '@/lib/path'
import type { OpenFile } from '@/store/slices/editor'
import { conflictOverviewFileId } from '@/store/slices/editor/file-ids/editor-file-ids'

type EditorDraftState = Pick<AppState, 'editorDrafts' | 'openFiles'>
type EditorPanelDraftSelector = (state: EditorDraftState) => Record<string, string>

const EMPTY_EDITOR_PANEL_DRAFTS = Object.freeze({}) as Record<string, string>

export function createEditorPanelDraftSelector(
  activeFile: OpenFile | null
): EditorPanelDraftSelector {
  // Why: previews and conflict review can render a related file, but drafts
  // from every other panel must not wake this editor on each keystroke.
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
  // Why: an overview file open in a tab shows under that tab's id (a server file's is not its path).
  const selectedFileIds = (state: EditorDraftState): string[] =>
    overviewPaths.length === 0 || !activeFile
      ? fileIds
      : Array.from(
          new Set([
            ...fileIds,
            ...overviewPaths.map((path) =>
              conflictOverviewFileId(state.openFiles, activeFile.worktreeId, path)
            )
          ])
        )
  let previousDrafts: AppState['editorDrafts'] | null = null
  let previousSelection = EMPTY_EDITOR_PANEL_DRAFTS

  return (state) => {
    // Why: every Zustand write reruns the selector. The slice identity guard
    // keeps unrelated terminal/status traffic allocation-free.
    if (previousDrafts === state.editorDrafts) {
      return previousSelection
    }
    previousDrafts = state.editorDrafts

    const ids = selectedFileIds(state)
    const changed = ids.some((fileId) => {
      const draft = state.editorDrafts[fileId]
      return (
        draft !== previousSelection[fileId] ||
        (draft === undefined && Object.hasOwn(previousSelection, fileId))
      )
    })
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
