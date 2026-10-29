import { editSessionSource } from '@/store/session-source-edits'
import type { AppState } from '../../../types'
import type { EditorGet, EditorSet } from '../types/editor-set-get'
import {
  editorBufferSiblingViewIds,
  type EditorBufferViewIndex
} from '../buffers/editor-buffer-views'
import type { EditorViewMode, MarkdownViewMode } from '../types/open-file'
import { clampMarkdownTocPanelWidth } from '../../../../../../shared/markdown-toc-panel-width'
import {
  clampCombinedDiffFileTreeWidth,
  COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH
} from '../../../../../../shared/combined-diff-file-tree-width'

export type EditorDraftState = {
  // Why: drafts live in the store (not a hidden mounted EditorPanel, #300) so the editor UI can unmount without losing edits.
  editorDrafts: Record<string, string>
  setEditorDraft: (fileId: string, content: string) => void
  setCsvPreviewOnly: (fileId: string, enabled: boolean) => void
  clearEditorDraft: (fileId: string) => void
  clearEditorDrafts: (fileIds: string[]) => void
  markdownViewMode: Record<string, MarkdownViewMode>
  setMarkdownViewMode: (fileId: string, mode: MarkdownViewMode) => void
  // Why: per-file opt-in to open an oversized markdown file in the rich editor despite the size limit.
  markdownRichModeSizeOverride: Record<string, boolean>
  setMarkdownRichModeSizeOverride: (fileId: string, enabled: boolean) => void
  editorViewMode: Record<string, EditorViewMode>
  setEditorViewMode: (fileId: string, mode: EditorViewMode) => void
  markdownFrontmatterVisible: Record<string, boolean>
  setMarkdownFrontmatterVisible: (fileId: string, visible: boolean) => void
  markdownTableOfContentsVisible: Record<string, boolean>
  setMarkdownTableOfContentsVisible: (fileId: string, visible: boolean) => void
  markdownTocPanelWidth: number
  setMarkdownTocPanelWidth: (width: number) => void
  combinedDiffFileTreeWidth: number
  setCombinedDiffFileTreeWidth: (width: number) => void
}

/** Drops the drafts of every view sharing a record with `fileIds`. */
function clearEditorDraftsOf<TState extends Pick<AppState, 'editorDrafts'> & EditorBufferViewIndex>(
  s: TState,
  fileIds: readonly string[]
) {
  const edit = editSessionSource<Pick<AppState, 'editorDrafts'>>(s)
  let changed = false
  for (const fileId of fileIds) {
    for (const id of [fileId, ...editorBufferSiblingViewIds(s, fileId)]) {
      if (id in s.editorDrafts) {
        edit.remove('editorDrafts', id)
        changed = true
      }
    }
  }
  return changed ? edit.finish() : undefined
}

export function createEditorDraftState(set: EditorSet, _get: EditorGet): EditorDraftState {
  return {
    editorDrafts: {},
    setCsvPreviewOnly: (fileId, enabled) =>
      set((state) => {
        const sourceEdit = editSessionSource(state)

        const file = state.openFiles.find((candidate) => candidate.id === fileId)
        if (!file || Boolean(file.csvPreviewOnly) === enabled) {
          return undefined
        }
        sourceEdit
          .sequence('openFiles')
          .map((candidate) =>
            candidate.id === fileId
              ? { ...candidate, csvPreviewOnly: enabled || undefined }
              : candidate
          )
        return sourceEdit.finish({})
      }),
    setEditorDraft: (fileId, content) =>
      set((s) => {
        const viewIds = [fileId, ...editorBufferSiblingViewIds(s, fileId)]
        if (viewIds.every((id) => s.editorDrafts[id] === content)) {
          return undefined
        }
        // Read-only drafts could trigger dirty/autosave/hot-exit overwrite of agent transcripts; refuse them.
        const file = s.openFiles.find((f) => f.id === fileId)
        if (file?.readOnly === true || file?.csvPreviewOnly === true) {
          return undefined
        }
        const edit = editSessionSource(s)
        for (const id of viewIds) {
          edit.set('editorDrafts', id, content)
        }
        return edit.finish()
      }),
    clearEditorDraft: (fileId) => set((s) => clearEditorDraftsOf(s, [fileId])),
    clearEditorDrafts: (fileIds) => set((s) => clearEditorDraftsOf(s, fileIds)),

    markdownViewMode: {},
    setMarkdownViewMode: (fileId, mode) =>
      set((s) => ({
        markdownViewMode: { ...s.markdownViewMode, [fileId]: mode }
      })),

    markdownRichModeSizeOverride: {},
    setMarkdownRichModeSizeOverride: (fileId, enabled) =>
      set((s) => {
        // Why: default is false — delete rather than store it so the record stays minimal.
        if (!enabled) {
          if (!(fileId in s.markdownRichModeSizeOverride)) {
            return undefined
          }
          const next = { ...s.markdownRichModeSizeOverride }
          delete next[fileId]
          return { markdownRichModeSizeOverride: next }
        }
        return {
          markdownRichModeSizeOverride: { ...s.markdownRichModeSizeOverride, [fileId]: true }
        }
      }),

    editorViewMode: {},
    setEditorViewMode: (fileId, mode) =>
      set((s) => {
        // Why: default is 'edit' — delete rather than store it so the record stays minimal and hydration round-trips cleanly.
        if (mode === 'edit') {
          if (!(fileId in s.editorViewMode)) {
            return undefined
          }
          const next = { ...s.editorViewMode }
          delete next[fileId]
          return { editorViewMode: next }
        }
        return { editorViewMode: { ...s.editorViewMode, [fileId]: mode } }
      }),

    markdownFrontmatterVisible: {},
    setMarkdownFrontmatterVisible: (fileId, visible) =>
      set((s) => {
        // Why: don't persist the default value; delete instead so the map carries only overrides and hydration round-trips cleanly.
        if (visible) {
          if (!(fileId in s.markdownFrontmatterVisible)) {
            return undefined
          }
          return editSessionSource(s).remove('markdownFrontmatterVisible', fileId).finish()
        }
        return editSessionSource(s).set('markdownFrontmatterVisible', fileId, false).finish({})
      }),

    markdownTableOfContentsVisible: {},
    setMarkdownTableOfContentsVisible: (fileId, visible) =>
      set((s) => {
        if (!visible) {
          if (!(fileId in s.markdownTableOfContentsVisible)) {
            return undefined
          }
          const next = { ...s.markdownTableOfContentsVisible }
          delete next[fileId]
          return { markdownTableOfContentsVisible: next }
        }
        return {
          markdownTableOfContentsVisible: {
            ...s.markdownTableOfContentsVisible,
            [fileId]: true
          }
        }
      }),

    markdownTocPanelWidth: 240,
    setMarkdownTocPanelWidth: (width) =>
      set((s) => ({
        markdownTocPanelWidth: clampMarkdownTocPanelWidth(width, undefined, s.markdownTocPanelWidth)
      })),

    combinedDiffFileTreeWidth: COMBINED_DIFF_FILE_TREE_DEFAULT_WIDTH,
    setCombinedDiffFileTreeWidth: (width) =>
      set((s) => ({
        combinedDiffFileTreeWidth: clampCombinedDiffFileTreeWidth(
          width,
          undefined,
          s.combinedDiffFileTreeWidth
        )
      }))
  }
}
