type MarkdownViewMode = 'source' | 'rich'

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

  // Why: large markdown files stay editable, but ProseMirror's full-document
  // tree and serialization path make rich mode noticeably laggy there. Treat
  // "too large" as another safety condition that routes the user to Monaco
  // instead of leaving the choice scattered across render branches.
  if (exceedsRichModeSizeLimit) {
    return 'source'
  }

  // Why: rich view is the user's "formatted markdown" choice, not a promise
  // that Tiptap owns the document. When rich editing is unsafe, we must fall
  // back to the pre-#264 markdown preview instead of silently flipping to raw
  // source mode and making preview appear broken.
  return hasRichModeUnsupportedContent ? 'preview' : 'rich-editor'
}
