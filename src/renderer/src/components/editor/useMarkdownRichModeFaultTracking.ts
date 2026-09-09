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

// Why: recording that a Rich attempt fell back or recovered is durable per-tab
// state, a side effect, so it lives in an effect keyed off the render model's
// output, never inside render.
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
    // Why: a successful Rich attempt for this content clears the fault,
    // whatever content is currently stored for this tab.
    setMarkdownRichModeFaultedContent(fileId, null)
  }, [
    fileId,
    mdViewMode,
    inlineMarkdownRenderState,
    inlineMarkdownContent,
    setMarkdownRichModeFaultedContent
  ])
}
