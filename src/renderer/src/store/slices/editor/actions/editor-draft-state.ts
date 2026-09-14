import type { EditorGet, EditorSet } from '../types/editor-set-get'
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

export function createEditorDraftState(set: EditorSet, _get: EditorGet): EditorDraftState {
  return {
    editorDrafts: {},
    setEditorDraft: (fileId, content) =>
      set((s) => {
        // Why: read-only tabs must never accrue a draft — it seeds dirty/autosave/hot-exit restore that could overwrite an agent transcript.
        const file = s.openFiles.find((f) => f.id === fileId)
        if (file?.readOnly === true) {
          return s
        }
        return { editorDrafts: { ...s.editorDrafts, [fileId]: content } }
      }),
    clearEditorDraft: (fileId) =>
      set((s) => {
        if (!(fileId in s.editorDrafts)) {
          return s
        }
        const next = { ...s.editorDrafts }
        delete next[fileId]
        return { editorDrafts: next }
      }),
    clearEditorDrafts: (fileIds) =>
      set((s) => {
        if (fileIds.length === 0) {
          return s
        }
        const next = { ...s.editorDrafts }
        let changed = false
        for (const fileId of fileIds) {
          if (fileId in next) {
            delete next[fileId]
            changed = true
          }
        }
        return changed ? { editorDrafts: next } : s
      }),

    // Markdown view mode
    markdownViewMode: {},
    setMarkdownViewMode: (fileId, mode) =>
      set((s) => ({
        markdownViewMode: { ...s.markdownViewMode, [fileId]: mode }
      })),

    // Rich-markdown size-limit override
    markdownRichModeSizeOverride: {},
    setMarkdownRichModeSizeOverride: (fileId, enabled) =>
      set((s) => {
        // Why: default is false — delete rather than store it so the record stays minimal.
        if (!enabled) {
          if (!(fileId in s.markdownRichModeSizeOverride)) {
            return s
          }
          const next = { ...s.markdownRichModeSizeOverride }
          delete next[fileId]
          return { markdownRichModeSizeOverride: next }
        }
        return {
          markdownRichModeSizeOverride: { ...s.markdownRichModeSizeOverride, [fileId]: true }
        }
      }),

    // Editor view mode (edit vs changes-diff). See EditorViewMode.
    editorViewMode: {},
    setEditorViewMode: (fileId, mode) =>
      set((s) => {
        // Why: default is 'edit' — delete rather than store it so the record stays minimal and hydration round-trips cleanly.
        if (mode === 'edit') {
          if (!(fileId in s.editorViewMode)) {
            return s
          }
          const next = { ...s.editorViewMode }
          delete next[fileId]
          return { editorViewMode: next }
        }
        return { editorViewMode: { ...s.editorViewMode, [fileId]: mode } }
      }),

    // Markdown preview front-matter visibility (#4468).
    markdownFrontmatterVisible: {},
    setMarkdownFrontmatterVisible: (fileId, visible) =>
      set((s) => {
        // Why: don't persist the default value; delete instead so the map carries only overrides and hydration round-trips cleanly.
        if (visible) {
          if (!(fileId in s.markdownFrontmatterVisible)) {
            return s
          }
          const next = { ...s.markdownFrontmatterVisible }
          delete next[fileId]
          return { markdownFrontmatterVisible: next }
        }
        return { markdownFrontmatterVisible: { ...s.markdownFrontmatterVisible, [fileId]: false } }
      }),

    // Markdown table of contents visibility
    markdownTableOfContentsVisible: {},
    setMarkdownTableOfContentsVisible: (fileId, visible) =>
      set((s) => {
        if (!visible) {
          if (!(fileId in s.markdownTableOfContentsVisible)) {
            return s
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

    // Markdown table of contents panel sizing
    markdownTocPanelWidth: 240,
    setMarkdownTocPanelWidth: (width) =>
      set((s) => ({
        markdownTocPanelWidth: clampMarkdownTocPanelWidth(width, undefined, s.markdownTocPanelWidth)
      })),

    // Combined diff file tree sizing
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
