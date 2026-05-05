import type { MarkdownViewMode } from '@/store/slices/editor'

export type MarkdownRenderMode = 'source' | 'rich-editor' | 'preview'

export function getMarkdownRenderMode({
  exceedsRichModeSizeLimit,
  hasRichModeUnsupportedContent,
  viewMode
}: {
  exceedsRichModeSizeLimit: boolean
  hasRichModeUnsupportedContent: boolean
  viewMode: MarkdownViewMode
}): MarkdownRenderMode {
  if (viewMode === 'source') {
    return 'source'
  }

  // Why: an explicit preview choice should stay in the rendered markdown view
  // even when the rich editor would otherwise fall back for size or syntax.
  // The user asked for read-only preview, not for Tiptap ownership.
  if (viewMode === 'preview') {
    return 'preview'
  }

  // Why: large markdown files stay editable, but ProseMirror's full-document
  // tree and serialization path make rich mode noticeably laggy there. Treat
  // "too large" as another safety condition that routes the user to Monaco
  // instead of leaving the choice scattered across render branches.
  if (exceedsRichModeSizeLimit) {
    return 'source'
  }

  // Why: rich view is the user's "formatted markdown" choice, not a promise
  // that Tiptap owns the document. Now that Orca has a dedicated preview tab,
  // unsafe rich documents should stay editable in source mode here instead of
  // silently turning the current editor tab into a read-only preview surface.
  return hasRichModeUnsupportedContent ? 'source' : 'rich-editor'
}
