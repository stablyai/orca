import type React from 'react'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import { MarkdownPreviewSurface } from './MarkdownPreviewSurface'
import type { MarkdownPreviewProps } from './markdown-preview-types'
import { useMarkdownPreviewAnnotationRenderers } from './use-markdown-preview-annotation-renderers'
import { useMarkdownPreviewComponents } from './use-markdown-preview-components'
import { useMarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import { useMarkdownPreviewReviewActions } from './use-markdown-preview-review-actions'
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
  const foundation = useMarkdownPreviewFoundation({
    content,
    filePath,
    sourceFileId,
    sourceWorktreeId,
    sourceRuntimeEnvironmentId,
    showTableOfContents,
    markdownDocuments,
    markdownAnnotationsEnabled
  })
  const viewport = useMarkdownPreviewViewport({
    foundation,
    scrollCacheKey,
    initialAnchor,
    content,
    markdownAnnotationsEnabled
  })
  const reviewActions = useMarkdownPreviewReviewActions({ foundation, viewport })
  const annotationRenderers = useMarkdownPreviewAnnotationRenderers({
    foundation,
    reviewActions,
    filePath,
    content,
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
