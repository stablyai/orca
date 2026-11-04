import { useCallback, useRef } from 'react'
import { VIRTUALIZED_SCROLL_ANCHOR_RECORD_EVENT } from '@/hooks/useVirtualizedScrollAnchor'
import type { MarkdownDocument } from '../../../../../../shared/filesystem-entry-types'
import { MarkdownPreviewSurface } from './MarkdownPreviewSurface'
import type { MarkdownPreviewProps } from '../render-tree/markdown-preview-types'
import { useMarkdownPreviewAnnotationRenderers } from '../review/use-markdown-preview-annotation-renderers'
import { useMarkdownPreviewComponents } from '../render-tree/use-markdown-preview-components'
import { useMarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import { useMarkdownPreviewReviewActions } from '../review/use-markdown-preview-review-actions'
import { exceedsMarkdownRichModeSizeLimit } from '../../markdown/render-mode/markdown-rich-size-limit'
import { useMarkdownPreviewDocument } from '../document-worker/use-markdown-preview-document'
import { useMarkdownPreviewDocumentSearch } from '../search/use-markdown-preview-document-search'
import type { VirtualMarkdownPreviewNavigation } from '../viewport/use-markdown-preview-navigation'
import { useMarkdownPreviewViewport } from '../viewport/use-markdown-preview-viewport'
import { readMarkdownPreviewChatSelection } from '../review/markdown-preview-chat-selection'
import { SelectionAddToChatPopover } from '../../../native-chat/SelectionAddToChatPopover'
import { addSelectionToWorkspaceChatOrExplain } from '../../../native-chat/native-chat-workspace-selection'

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

  const chatWorktreeId = foundation.sourceWorktree?.id ?? null
  const chatRelativePath = foundation.sourceRelativePath

  return (
    <>
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
      <SelectionAddToChatPopover
        rootRef={foundation.rootRef}
        enabled={chatWorktreeId !== null && chatRelativePath !== null}
        readQuotable={(root) =>
          chatRelativePath === null
            ? null
            : readMarkdownPreviewChatSelection(root, displayedContent, chatRelativePath)
        }
        onAdd={(text) =>
          chatWorktreeId && addSelectionToWorkspaceChatOrExplain(chatWorktreeId, text)
        }
      />
    </>
  )
}
