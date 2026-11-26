import type { AppState } from '../../../types'
import { isReadOnlyEditorView } from '../types/open-file'
import type { GitDiffEncoding } from '../../../../../../shared/git/diff/git-diff-compare-types'
import { withDiffContentReloadRequest } from '../file-ids/editor-file-ids'
import type { EditorSet } from '../types/editor-set-get'
import { editorBufferSiblingViewIds, type EditorBufferViewIndex } from './editor-buffer-views'

export type EditorDraftState = {
  editorDrafts: Record<string, string>
  setEditorDraft: (fileId: string, content: string) => void
  setDiffEncoding: (fileId: string, encoding: GitDiffEncoding) => void
  setCsvPreviewOnly: (fileId: string, enabled: boolean) => void
  clearEditorDraft: (fileId: string) => void
  clearEditorDrafts: (fileIds: string[]) => void
}

/** Drops the drafts of every view sharing a record with `fileIds`. */
function clearEditorDraftsOf<TState extends Pick<AppState, 'editorDrafts'> & EditorBufferViewIndex>(
  s: TState,
  fileIds: readonly string[]
): TState | Pick<AppState, 'editorDrafts'> {
  let next = s.editorDrafts
  for (const fileId of fileIds) {
    for (const id of [fileId, ...editorBufferSiblingViewIds(s, fileId)]) {
      if (id in next) {
        next = next === s.editorDrafts ? { ...next } : next
        delete next[id]
      }
    }
  }
  return next === s.editorDrafts ? s : { editorDrafts: next }
}

export function createEditorDraftState(set: EditorSet): EditorDraftState {
  return {
    editorDrafts: {},
    setDiffEncoding: (fileId, encoding) =>
      set((state) => {
        const file = state.openFiles.find((candidate) => candidate.id === fileId)
        if (
          !file ||
          file.mode !== 'diff' ||
          file.isDirty ||
          (file.diffEncoding ?? 'utf-8') === encoding
        ) {
          return state
        }
        const updated = withDiffContentReloadRequest({
          ...file,
          diffEncoding: encoding === 'utf-8' ? undefined : encoding
        })
        return {
          openFiles: state.openFiles.map((candidate) => (candidate === file ? updated : candidate))
        }
      }),
    setCsvPreviewOnly: (fileId, enabled) =>
      set((state) => {
        const file = state.openFiles.find((candidate) => candidate.id === fileId)
        if (!file || Boolean(file.csvPreviewOnly) === enabled) {
          return state
        }
        return {
          openFiles: state.openFiles.map((candidate) =>
            candidate.id === fileId
              ? { ...candidate, csvPreviewOnly: enabled || undefined }
              : candidate
          )
        }
      }),
    setEditorDraft: (fileId, content) =>
      set((s) => {
        const viewIds = [fileId, ...editorBufferSiblingViewIds(s, fileId)]
        if (viewIds.every((id) => s.editorDrafts[id] === content)) {
          return s
        }
        // Read-only drafts could trigger dirty/autosave/hot-exit overwrite of agent transcripts; refuse them.
        const file = s.openFiles.find((f) => f.id === fileId)
        if (file && isReadOnlyEditorView(file)) {
          return s
        }
        const next = { ...s.editorDrafts }
        for (const id of viewIds) {
          next[id] = content
        }
        return { editorDrafts: next }
      }),
    clearEditorDraft: (fileId) => set((s) => clearEditorDraftsOf(s, [fileId])),
    clearEditorDrafts: (fileIds) => set((s) => clearEditorDraftsOf(s, fileIds))
  }
}
