import { Loader2 } from 'lucide-react'
import { useMemo, type RefObject } from 'react'
import { extractFrontMatter, markdownFrontMatterInner } from './markdown-frontmatter'
import {
  VirtualMarkdownPreviewBody,
  type VirtualMarkdownPreviewNavigation
} from './VirtualMarkdownPreviewBody'
import type { useMarkdownPreviewDocument } from './use-markdown-preview-document'
import type { useMarkdownPreviewDocumentSearch } from './use-markdown-preview-document-search'
import type { Components } from 'react-markdown'
import { translate } from '@/i18n/i18n'
import { MarkdownTableOfContentsPanel } from './MarkdownTableOfContentsPanel'
import { MarkdownPreviewBody } from './MarkdownPreviewBody'
import { MarkdownPreviewReviewToolbar } from './MarkdownPreviewReviewToolbar'
import { MarkdownPreviewSearchBar } from './MarkdownPreviewSearchBar'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewReviewActions } from './use-markdown-preview-review-actions'
import type { MarkdownPreviewViewport } from './use-markdown-preview-viewport'

export function MarkdownPreviewSurface({
  largePreview,
  documentState,
  documentSearch,
  largeNavigationRef,
  scrollCacheKey,
  foundation,
  viewport,
  reviewActions,
  components,
  filePath,
  showTableOfContents,
  onCloseTableOfContents
}: {
  largePreview: boolean
  documentState: ReturnType<typeof useMarkdownPreviewDocument>
  documentSearch: ReturnType<typeof useMarkdownPreviewDocumentSearch>
  largeNavigationRef: RefObject<VirtualMarkdownPreviewNavigation | null>
  scrollCacheKey: string
  foundation: MarkdownPreviewFoundation
  viewport: MarkdownPreviewViewport
  reviewActions: MarkdownPreviewReviewActions
  components: Components
  filePath: string
  showTableOfContents: boolean
  onCloseTableOfContents?: () => void
}): React.JSX.Element {
  const {
    isSearchOpen,
    canShowReviewTools,
    tableOfContentsItems,
    editorFontSize,
    isDark,
    bodyRef,
    frontmatterVisible,
    renderedContent
  } = foundation

  const displayedContent =
    documentState.status === 'ready' ? documentState.content : renderedContent
  const frontMatter = useMemo(() => extractFrontMatter(displayedContent), [displayedContent])
  const frontMatterInner = useMemo(() => markdownFrontMatterInner(frontMatter), [frontMatter])

  return (
    <div className="markdown-preview-shell">
      {showTableOfContents ? (
        <MarkdownTableOfContentsPanel
          virtualized={largePreview}
          items={
            largePreview
              ? documentState.status === 'ready'
                ? documentState.document.toc
                : []
              : tableOfContentsItems
          }
          onClose={onCloseTableOfContents ?? (() => {})}
          onNavigate={viewport.navigateToTableOfContentsItem}
        />
      ) : null}
      <div
        ref={viewport.setRootRef}
        tabIndex={0}
        style={{
          fontSize: `${editorFontSize}px`,
          overflowAnchor: largePreview ? 'none' : undefined
        }}
        className={`markdown-preview h-full min-h-0 overflow-auto scrollbar-editor ${isDark ? 'markdown-dark' : 'markdown-light'}`}
      >
        {isSearchOpen ? (
          <MarkdownPreviewSearchBar
            searchFailed={documentSearch.failed}
            searchPending={documentSearch.pending}
            searchTruncated={documentSearch.truncated}
            foundation={foundation}
            viewport={viewport}
          />
        ) : null}
        {canShowReviewTools ? (
          <div inert={documentState.refreshing || undefined}>
            <MarkdownPreviewReviewToolbar
              foundation={foundation}
              reviewActions={reviewActions}
              filePath={filePath}
            />
          </div>
        ) : null}
        {/* Why: OS page translation can replace react-owned text nodes and crash reconciliation. */}
        <div
          ref={bodyRef}
          className="markdown-body"
          translate="no"
          data-markdown-preview-incomplete={largePreview || undefined}
        >
          {frontMatter && frontmatterVisible ? (
            <div className="mb-4 rounded border border-border/60 bg-muted/40 px-3 py-2">
              <div className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {translate('auto.components.editor.MarkdownPreview.2b2b31382c', 'Front Matter')}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground font-mono scrollbar-editor">
                {frontMatterInner}
              </pre>
            </div>
          ) : null}
          {largePreview ? (
            <>
              <p className="relative text-xs text-muted-foreground">
                {translate(
                  'editor.markdownPreview.largeNotice',
                  'Large preview. Use source view to copy the complete document. PDF export is unavailable.'
                )}
                {documentState.refreshing ? (
                  <span
                    role={documentState.refreshError ? 'alert' : 'status'}
                    className="absolute inset-0 bg-background"
                  >
                    {documentState.refreshError
                      ? translate(
                          'editor.markdownPreview.refreshFailed',
                          'Preview update failed. Showing the previous version; open source view for current content.'
                        )
                      : translate('editor.markdownPreview.preparing', 'Preparing preview…')}
                  </span>
                ) : null}
              </p>
              {documentState.status === 'ready' ? (
                <VirtualMarkdownPreviewBody
                  inert={documentState.refreshing}
                  revision={documentState.revision}
                  document={documentState.document}
                  client={documentState.client}
                  components={components}
                  rootRef={foundation.rootRef}
                  bodyRef={bodyRef}
                  navigationRef={largeNavigationRef}
                  query={foundation.query}
                  matches={documentSearch.matches}
                  activeMatchIndex={foundation.activeMatchIndex}
                  searchInstance={foundation.searchInstanceRef.current}
                  scrollCacheKey={scrollCacheKey}
                  activeAnnotationBlockKey={foundation.activeAnnotationBlockKey}
                />
              ) : documentState.status === 'error' ? (
                <p role="alert" className="text-sm text-muted-foreground">
                  {translate(
                    'editor.markdownPreview.processingFailed',
                    'This document cannot be rendered within the preview limits. Open source view to read the complete file.'
                  )}
                </p>
              ) : (
                <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {translate('editor.markdownPreview.preparing', 'Preparing preview…')}
                </p>
              )}
            </>
          ) : (
            <MarkdownPreviewBody content={renderedContent} components={components} />
          )}
        </div>
      </div>
    </div>
  )
}
