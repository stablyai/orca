import React, { useMemo } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownDocument } from '../../../../shared/filesystem-entry-types'
import CodeBlockCopyButton from './CodeBlockCopyButton'
import MermaidBlock from './MermaidBlock'
import {
  getMarkdownDocLinkAnchor,
  parseMarkdownDocLinkHref,
  resolveMarkdownDocLink
} from './markdown-doc-links'
import {
  getMarkdownPreviewAnnotationQuote,
  getMarkdownPreviewBlockRange,
  hasMarkdownPreviewNestedBlock
} from './markdown-preview-block-model'
import { handleMarkdownPreviewLinkClick } from './markdown-preview-link-actions'
import { isMarkdownPreviewOpenModifier } from './markdown-preview-links'
import type { MarkdownPreviewPositionNode } from './markdown-preview-types'
import type { MarkdownPreviewAnnotationRenderers } from './use-markdown-preview-annotation-renderers'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewReviewActions } from './use-markdown-preview-review-actions'
import type { MarkdownPreviewViewport } from './use-markdown-preview-viewport'
import { useLocalImageSrc } from './useLocalImageSrc'

export function useMarkdownPreviewComponents({
  foundation,
  viewport,
  reviewActions,
  annotationRenderers,
  filePath,
  onOpenDocument
}: {
  foundation: MarkdownPreviewFoundation
  viewport: MarkdownPreviewViewport
  reviewActions: MarkdownPreviewReviewActions
  annotationRenderers: MarkdownPreviewAnnotationRenderers
  filePath: string
  onOpenDocument?: (
    document: MarkdownDocument,
    options?: { anchor?: string | null }
  ) => void | Promise<void>
}): Components {
  const {
    markdownDocumentIndex,
    activateMarkdownLink,
    isDark,
    isMac,
    imageRuntimeContext,
    sourceRoutingWorktreeId,
    worktreeRoot,
    resolvedSourceRuntimeEnvironmentId,
    sourceOwner,
    sourceConnectionId,
    worktreesByRepo,
    sourceWorktree,
    openFile,
    openMarkdownPreview,
    setMarkdownViewMode,
    pendingEditorRevealFrameIdsRef,
    setPendingEditorReveal
  } = foundation
  const { scrollToAnchor } = viewport
  const { getMarkdownCommentsForRange, handleAnnotatedMarkdownBlockClick } = reviewActions
  const { renderAnnotationControls, wrapAnnotatedBlock } = annotationRenderers

  return useMemo(() => {
    const linkContext = {
      isMac,
      sourceOwner,
      sourceRoutingWorktreeId,
      sourceConnectionId,
      resolvedSourceRuntimeEnvironmentId,
      worktreeRoot,
      worktreesByRepo,
      sourceWorktree,
      activateMarkdownLink,
      openFile,
      openMarkdownPreview,
      setMarkdownViewMode,
      pendingEditorRevealFrameIdsRef,
      setPendingEditorReveal,
      scrollToAnchor
    }

    return {
      a: ({ href, children, className, ...props }) => {
        const docLinkTarget = parseMarkdownDocLinkHref(href)
        if (docLinkTarget !== null) {
          const resolution = resolveMarkdownDocLink(docLinkTarget, markdownDocumentIndex)
          const resolvedDocument = resolution.status === 'resolved' ? resolution.document : null
          const title =
            resolution.status === 'ambiguous' ? 'Document link is ambiguous' : 'Document not found'

          const handleDocLinkClick = (event: React.MouseEvent<HTMLAnchorElement>): void => {
            event.preventDefault()
            if (resolvedDocument && onOpenDocument) {
              void onOpenDocument(resolvedDocument, {
                anchor: getMarkdownDocLinkAnchor(docLinkTarget)
              })
            }
          }

          return (
            <a
              {...props}
              href={href}
              className={`${className ?? ''} ${
                resolvedDocument ? 'markdown-doc-link' : 'markdown-doc-link-broken'
              }`.trim()}
              title={resolvedDocument ? undefined : title}
              onClick={handleDocLinkClick}
            >
              {children}
            </a>
          )
        }

        return (
          <a
            {...props}
            href={href}
            className={className}
            onClick={(event) =>
              void handleMarkdownPreviewLinkClick({ event, href, filePath, context: linkContext })
            }
            style={{ cursor: 'pointer' }}
          >
            {children}
          </a>
        )
      },
      img: function MarkdownImg({ src, alt, ...props }) {
        const resolvedSrc = useLocalImageSrc(src, filePath, undefined, imageRuntimeContext)
        const handleImageClick = (event: React.MouseEvent<HTMLImageElement>): void => {
          if (!isMarkdownPreviewOpenModifier(event, isMac)) {
            return
          }

          if (!src || !sourceRoutingWorktreeId || !worktreeRoot) {
            return
          }

          event.preventDefault()
          event.stopPropagation()
          void activateMarkdownLink(src, {
            sourceFilePath: filePath,
            worktreeId: sourceRoutingWorktreeId,
            worktreeRoot,
            runtimeEnvironmentId: resolvedSourceRuntimeEnvironmentId,
            sourceOwner
          })
        }

        return <img {...props} src={resolvedSrc} alt={alt ?? ''} onClick={handleImageClick} />
      },
      code: ({ className, children, ...props }) => {
        if (/language-mermaid/.test(className || '')) {
          return (
            <MermaidBlock content={String(children).trimEnd()} isDark={isDark} htmlLabels={false} />
          )
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      },
      pre: ({ node, children, ...props }) => {
        const child = React.Children.toArray(children)[0]
        if (React.isValidElement(child) && child.type === MermaidBlock) {
          return <>{children}</>
        }
        return wrapAnnotatedBlock(
          'pre',
          node as MarkdownPreviewPositionNode,
          <CodeBlockCopyButton {...props}>{children}</CodeBlockCopyButton>
        )
      },
      p: ({ node, children, ...props }) =>
        wrapAnnotatedBlock('p', node as MarkdownPreviewPositionNode, <p {...props}>{children}</p>),
      blockquote: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'blockquote',
          node as MarkdownPreviewPositionNode,
          <blockquote {...props}>{children}</blockquote>
        ),
      table: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'table',
          node as MarkdownPreviewPositionNode,
          <table {...props}>{children}</table>
        ),
      li: ({ node, children, ...props }) => {
        const positionNode = node as MarkdownPreviewPositionNode
        const range = hasMarkdownPreviewNestedBlock(positionNode)
          ? null
          : getMarkdownPreviewBlockRange(positionNode)
        if (!range) {
          return <li {...props}>{children}</li>
        }
        const blockKey = `li:${range.startLine}-${range.endLine}`
        const hasReviewNotes = getMarkdownCommentsForRange(range).length > 0
        const controls = renderAnnotationControls(
          range,
          blockKey,
          getMarkdownPreviewAnnotationQuote(children)
        )
        return (
          <li {...props}>
            <div
              className={`markdown-annotation-list-block ${
                hasReviewNotes ? 'has-review-notes' : ''
              }`.trim()}
              data-source-line={range.startLine}
              data-source-end-line={range.endLine}
              data-annotation-block-key={controls ? blockKey : undefined}
              onClick={(event) => handleAnnotatedMarkdownBlockClick(range, event)}
            >
              <span className="markdown-annotation-list-content">{children}</span>
              {controls}
            </div>
          </li>
        )
      },
      h1: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'h1',
          node as MarkdownPreviewPositionNode,
          <h1 {...props} tabIndex={-1}>
            {children}
          </h1>
        ),
      h2: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'h2',
          node as MarkdownPreviewPositionNode,
          <h2 {...props} tabIndex={-1}>
            {children}
          </h2>
        ),
      h3: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'h3',
          node as MarkdownPreviewPositionNode,
          <h3 {...props} tabIndex={-1}>
            {children}
          </h3>
        ),
      h4: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'h4',
          node as MarkdownPreviewPositionNode,
          <h4 {...props} tabIndex={-1}>
            {children}
          </h4>
        ),
      h5: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'h5',
          node as MarkdownPreviewPositionNode,
          <h5 {...props} tabIndex={-1}>
            {children}
          </h5>
        ),
      h6: ({ node, children, ...props }) =>
        wrapAnnotatedBlock(
          'h6',
          node as MarkdownPreviewPositionNode,
          <h6 {...props} tabIndex={-1}>
            {children}
          </h6>
        )
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the image override is a hook component; listed inputs preserve its identity.
  }, [
    filePath,
    activateMarkdownLink,
    isDark,
    isMac,
    imageRuntimeContext,
    getMarkdownCommentsForRange,
    handleAnnotatedMarkdownBlockClick,
    markdownDocumentIndex,
    onOpenDocument,
    openFile,
    openMarkdownPreview,
    renderAnnotationControls,
    scrollToAnchor,
    setMarkdownViewMode,
    setPendingEditorReveal,
    sourceConnectionId,
    sourceOwner,
    sourceWorktree,
    resolvedSourceRuntimeEnvironmentId,
    sourceRoutingWorktreeId,
    worktreeRoot,
    worktreesByRepo,
    wrapAnnotatedBlock
  ])
}
