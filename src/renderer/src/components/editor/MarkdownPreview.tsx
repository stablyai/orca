import { useCallback, useRef } from 'react'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { MarkdownPreviewSurface } from './MarkdownPreviewSurface'
import type { MarkdownPreviewProps } from './markdown-preview-types'
import { useMarkdownPreviewAnnotationRenderers } from './use-markdown-preview-annotation-renderers'
import { useMarkdownPreviewComponents } from './use-markdown-preview-components'
import { useMarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import { useMarkdownPreviewReviewActions } from './use-markdown-preview-review-actions'
import { exceedsMarkdownRichModeSizeLimit } from './markdown-rich-size-limit'
import { useMarkdownPreviewDocument } from './use-markdown-preview-document'
import { useMarkdownPreviewDocumentSearch } from './use-markdown-preview-document-search'
import type { VirtualMarkdownPreviewNavigation } from './VirtualMarkdownPreviewBody'
import { useMarkdownPreviewViewport } from './use-markdown-preview-viewport'

export {
  decodeMarkdownPreviewAnchor,
  getMarkdownPreviewAnchorScrollTop
} from './markdown-preview-anchor-navigation'
export {
  deriveMarkdownPreviewSourceRoot,
  findMarkdownPreviewOpenedEditFileId,
  findMarkdownPreviewSourceOpenFile,
  getMarkdownPreviewSourceRelativePath,
  resolveMarkdownPreviewSourceWorktree
} from './markdown-preview-source-routing'

const EMPTY_MARKDOWN_DOCUMENTS: MarkdownDocument[] = []

export default function MarkdownPreview({
  content,
  filePath,
  sourceFileId = null,
  sourceWorktreeId = null,
  sourceRuntimeEnvironmentId = undefined,
  scrollCacheKey,
  initialAnchor = null,
  showTableOfContents = false,
  onCloseTableOfContents,
  markdownDocuments = EMPTY_MARKDOWN_DOCUMENTS,
  onOpenDocument,
  markdownAnnotationsEnabled = false
}: MarkdownPreviewProps): React.JSX.Element {
  const incomingLargePreview = exceedsMarkdownRichModeSizeLimit(content)
  const largeNavigationRef = useRef<VirtualMarkdownPreviewNavigation | null>(null)
  const foundation = useMarkdownPreviewFoundation({
    content,
    filePath,
    sourceFileId,
    sourceWorktreeId,
    sourceRuntimeEnvironmentId,
    showTableOfContents,
    markdownDocuments,
    markdownAnnotationsEnabled,
    largePreview: incomingLargePreview
  })
  const largePreview = exceedsMarkdownRichModeSizeLimit(foundation.renderedContent)
  const recordBeforeSwap = useCallback(() => {
    foundation.rootRef.current?.dispatchEvent(new Event(VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT))
  }, [foundation.rootRef])
  const documentState = useMarkdownPreviewDocument(
    foundation.renderedContent,
    largePreview,
    recordBeforeSwap
  )
  const annotationsEnabled = markdownAnnotationsEnabled && !documentState.refreshing
  const largeDocument = documentState.status === 'ready' ? documentState.document : null
  const largeClient = documentState.status === 'ready' ? documentState.client : null
  const documentSearch = useMarkdownPreviewDocumentSearch(largeClient, foundation, largePreview)
  const viewport = useMarkdownPreviewViewport({
    foundation,
    scrollCacheKey,
    initialAnchor,
    content,
    markdownAnnotationsEnabled: annotationsEnabled,
    largePreview,
    largeDocument,
    largeNavigationRef
  })
  const reviewActions = useMarkdownPreviewReviewActions({ foundation, viewport })
  const displayedContent =
    documentState.status === 'ready' ? documentState.content : foundation.renderedContent
  const annotationRenderers = useMarkdownPreviewAnnotationRenderers({
    foundation: { ...foundation, renderedContent: displayedContent },
    reviewActions,
    filePath,
    content: displayedContent,
    markdownAnnotationsEnabled
  })
  const components = useMarkdownPreviewComponents({
    foundation,
    viewport,
    reviewActions,
    annotationRenderers,
    filePath,
    onOpenDocument
  })

  return (
    <MarkdownPreviewSurface
      largePreview={largePreview}
      documentState={documentState}
      documentSearch={documentSearch}
      largeNavigationRef={largeNavigationRef}
      scrollCacheKey={scrollCacheKey}
      foundation={foundation}
      viewport={viewport}
      reviewActions={reviewActions}
      components={components}
      filePath={filePath}
      showTableOfContents={showTableOfContents}
      onCloseTableOfContents={onCloseTableOfContents}
    />
  )
}
