import type { MarkdownViewMode } from '@/store/slices/editor'

export type MarkdownRenderMode = 'source' | 'rich-editor' | 'preview'

export type MarkdownRenderState = {
  renderMode: MarkdownRenderMode
  richModeUnsupportedMessage: string | null
}

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

  // Explicit preview stays rendered even when rich editing is unsafe.
  if (viewMode === 'preview') {
    return 'preview'
  }

  // Keep large documents editable in Monaco without ProseMirror’s full-document rendering and serialization cost.
  if (exceedsRichModeSizeLimit) {
    return 'source'
  }

  // Unsafe rich documents need an editable source fallback; read-only preview has its own explicit mode.
  return hasRichModeUnsupportedContent ? 'source' : 'rich-editor'
}
