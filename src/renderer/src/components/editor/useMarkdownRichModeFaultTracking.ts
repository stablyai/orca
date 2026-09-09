import { useEffect } from 'react'
import type { MarkdownViewMode } from '@/store/slices/editor'
import type { MarkdownRenderState } from './markdown-render-mode'

type UseMarkdownRichModeFaultTrackingParams = {
  fileId: string | null
  mdViewMode: MarkdownViewMode
  inlineMarkdownRenderState: MarkdownRenderState | null
  inlineMarkdownContent: string | null
  setMarkdownRichModeFaultedContent: (fileId: string, content: string | null) => void
}

// Why: getMarkdownRenderMode only decides source-vs-rich-vs-preview for the
// content it's given; recording that a Rich attempt fell back (or recovered)
// as durable per-tab state is a side effect, so it belongs in an effect keyed
// off the render model's output rather than during render itself.
export function useMarkdownRichModeFaultTracking({
  fileId,
  mdViewMode,
  inlineMarkdownRenderState,
  inlineMarkdownContent,
  setMarkdownRichModeFaultedContent
}: UseMarkdownRichModeFaultTrackingParams): void {
  useEffect(() => {
    if (!fileId || mdViewMode !== 'rich' || inlineMarkdownRenderState === null) {
      return
    }
    if (inlineMarkdownRenderState.renderMode === 'source') {
      setMarkdownRichModeFaultedContent(fileId, inlineMarkdownContent)
      return
    }
    // Why: a successful Rich attempt for this content means it's no longer a
    // fault, whatever content is currently stored for this tab.
    setMarkdownRichModeFaultedContent(fileId, null)
  }, [
    fileId,
    mdViewMode,
    inlineMarkdownRenderState,
    inlineMarkdownContent,
    setMarkdownRichModeFaultedContent
  ])
}
