import React, { useMemo } from 'react'
import type { Components } from 'react-markdown'
import type { MarkdownDocument } from '../../../../../../shared/file-listing/file-document'
import CodeBlockCopyButton from './CodeBlockCopyButton'
import MermaidBlock from '../../diagrams/MermaidBlock'
import { useMermaidDiagramExpand } from '../../diagrams/use-mermaid-diagram-expand'
import {
  getMarkdownDocLinkAnchor,
  parseMarkdownDocLinkHref,
  resolveMarkdownDocLink
} from '../../markdown/documents/markdown-doc-links'
import {
  getMarkdownPreviewAnnotationQuote,
  getMarkdownPreviewBlockRange,
  hasMarkdownPreviewNestedBlock
} from '../review/markdown-preview-block-model'
import { preventMiddleButtonDefault } from '@/components/tab-bar/strip/middle-button-default-guard'
import {
  handleMarkdownPreviewLinkAuxClick,
  handleMarkdownPreviewLinkClick,
  isMarkdownPreviewExternalHttpHref
} from '../links/markdown-preview-link-actions'
import { isMarkdownPreviewOpenModifier } from '../../markdown/link-routing/markdown-preview-links'
import type { MarkdownPreviewPositionNode } from './markdown-preview-types'
import { useMarkdownPreviewAnnotations } from '../review/markdown-preview-annotation-context'
import type { MarkdownPreviewFoundation } from '../surface/use-markdown-preview-foundation'
import type { MarkdownPreviewViewport } from '../viewport/use-markdown-preview-viewport'
import { useLocalImageSrc } from '../../document-images/useLocalImageSrc'
import { documentResourceAccess } from '@/lib/files/access/local-file-access'
import { MarkdownGitHubCallout } from '@/components/comment-markdown/markdown-github-callout'
import { useLatestHandler } from '@/lib/use-latest-handler'
import { readGitHubCalloutKind } from '../../../../../../shared/github/markdown/github-callouts'
import { translate } from '@/i18n/i18n'

function hasMermaidCodeClass(value: unknown): boolean {
  return typeof value === 'string' && /language-mermaid/.test(value)
}

function annotatedHeading(
  Heading: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6'
): NonNullable<Components['h1']> {
  return function MarkdownPreviewHeading({ node, children, ...props }) {
    const { wrapAnnotatedBlock } = useMarkdownPreviewAnnotations()
    return wrapAnnotatedBlock(
      Heading,
      node as MarkdownPreviewPositionNode,
      <Heading {...props} tabIndex={-1}>
        {children}
      </Heading>
    )
  }
}

// Why: review-note state reaches blocks through context; new component types would remount the
// whole document and reset its scroll position.
const annotatedBlockComponents = {
  pre: function MarkdownPreviewPre({ node, children, ...props }) {
    const { wrapAnnotatedBlock } = useMarkdownPreviewAnnotations()
    const isMermaid = node?.children.some(
      (child) =>
        child.type === 'element' &&
        child.tagName === 'code' &&
        Array.isArray(child.properties.className) &&
        child.properties.className.some(hasMermaidCodeClass)
    )
    return wrapAnnotatedBlock(
      'pre',
      node,
      <CodeBlockCopyButton {...props} wrapInPre={!isMermaid}>
        {children}
      </CodeBlockCopyButton>
    )
  },
  p: function MarkdownPreviewParagraph({ node, children, ...props }) {
    const { wrapAnnotatedBlock } = useMarkdownPreviewAnnotations()
    return wrapAnnotatedBlock(
      'p',
      node as MarkdownPreviewPositionNode,
      <p {...props}>{children}</p>
    )
  },
  blockquote: function MarkdownPreviewBlockquote({ node, children, ...props }) {
    const { wrapAnnotatedBlock } = useMarkdownPreviewAnnotations()
    const calloutKind = readGitHubCalloutKind(node?.properties.dataCallout)
    return wrapAnnotatedBlock(
      'blockquote',
      node as MarkdownPreviewPositionNode,
      calloutKind ? (
        <MarkdownGitHubCallout kind={calloutKind}>{children}</MarkdownGitHubCallout>
      ) : (
        <blockquote {...props}>{children}</blockquote>
      )
    )
  },
  table: function MarkdownPreviewTable({ node, children, ...props }) {
    const { wrapAnnotatedBlock } = useMarkdownPreviewAnnotations()
    return wrapAnnotatedBlock(
      'table',
      node as MarkdownPreviewPositionNode,
      <table {...props}>{children}</table>
    )
  },
  tr: function MarkdownPreviewTableRow({ node, children, ...props }) {
    const { renderAnnotatedTableRow } = useMarkdownPreviewAnnotations()
    return renderAnnotatedTableRow(node as MarkdownPreviewPositionNode, props, children)
  },
  li: function MarkdownPreviewListItem({ node, children, ...props }) {
    const {
      getMarkdownCommentsForRange,
      handleAnnotatedMarkdownBlockClick,
      renderAnnotationControls
    } = useMarkdownPreviewAnnotations()
    const positionNode = node as MarkdownPreviewPositionNode
    const range = hasMarkdownPreviewNestedBlock(positionNode)
      ? null
      : getMarkdownPreviewBlockRange(positionNode)
    if (!range) {
      return <li {...props}>{children}</li>
    }
    const blockKey = `li:${range.startLine}-${range.endLine}`
    const controls = renderAnnotationControls(
      range,
      blockKey,
      getMarkdownPreviewAnnotationQuote(children)
    )
    if (!controls) {
      // Why: the list wrapper reserves the review-note grid column, so skip it like wrapAnnotatedBlock.
      return (
        <li {...props} data-source-line={range.startLine} data-source-end-line={range.endLine}>
          {children}
        </li>
      )
    }
    const hasReviewNotes = getMarkdownCommentsForRange(range).length > 0
    return (
      <li {...props}>
        <div
          className={`markdown-annotation-list-block ${
            hasReviewNotes ? 'has-review-notes' : ''
          }`.trim()}
          data-source-line={range.startLine}
          data-source-end-line={range.endLine}
          data-annotation-block-key={blockKey}
          onClick={(event) => handleAnnotatedMarkdownBlockClick(range, event)}
        >
          <span className="markdown-annotation-list-content">{children}</span>
          {controls}
        </div>
      </li>
    )
  },
  h1: annotatedHeading('h1'),
  h2: annotatedHeading('h2'),
  h3: annotatedHeading('h3'),
  h4: annotatedHeading('h4'),
  h5: annotatedHeading('h5'),
  h6: annotatedHeading('h6')
} satisfies Components

export function useMarkdownPreviewComponents({
  foundation,
  viewport,
  filePath,
  onOpenDocument
}: {
  foundation: MarkdownPreviewFoundation
  viewport: Pick<MarkdownPreviewViewport, 'scrollToAnchor'>
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
    worktreesByRepo,
    sourceWorktree,
    openFile,
    openMarkdownPreview,
    setMarkdownViewMode
  } = foundation
  const { scrollToAnchor } = viewport
  const expandMermaidDiagram = useMermaidDiagramExpand()
  // Why: saving a review note rewrites the worktree rows. Links read them at click time so that
  // write cannot rebuild components and remount images and Mermaid diagrams.
  const readWorktreeRouting = useLatestHandler(() => ({ worktreesByRepo, sourceWorktree }))

  return useMemo(() => {
    // Why: preview images come from document text, so main limits them to the document's roots.
    const imageAccess = documentResourceAccess(filePath)
    const linkContext = {
      isMac,
      sourceOwner,
      sourceRoutingWorktreeId,
      resolvedSourceRuntimeEnvironmentId,
      worktreeRoot,
      activateMarkdownLink,
      openFile,
      openMarkdownPreview,
      setMarkdownViewMode,
      scrollToAnchor
    }

    return {
      ...annotatedBlockComponents,
      a: ({ href, children, className, ...props }) => {
        const docLinkTarget = parseMarkdownDocLinkHref(href)
        if (docLinkTarget !== null) {
          const resolution = resolveMarkdownDocLink(docLinkTarget, markdownDocumentIndex)
          const resolvedDocument = resolution.status === 'resolved' ? resolution.document : null
          const title =
            resolution.status === 'ambiguous'
              ? translate(
                  'auto.components.editor.MarkdownPreview.docLinkAmbiguous',
                  'Document link is ambiguous'
                )
              : translate(
                  'auto.components.editor.MarkdownPreview.docLinkNotFound',
                  'Document not found'
                )

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

        const isMiddleClickable = isMarkdownPreviewExternalHttpHref(href, filePath)

        return (
          <a
            {...props}
            href={href}
            className={className}
            onMouseDown={isMiddleClickable ? preventMiddleButtonDefault : undefined}
            onMouseUp={isMiddleClickable ? preventMiddleButtonDefault : undefined}
            onAuxClick={
              isMiddleClickable
                ? (event) =>
                    handleMarkdownPreviewLinkAuxClick({
                      event,
                      href,
                      filePath,
                      context: { ...linkContext, ...readWorktreeRouting() }
                    })
                : undefined
            }
            onClick={(event) =>
              void handleMarkdownPreviewLinkClick({
                event,
                href,
                filePath,
                context: { ...linkContext, ...readWorktreeRouting() }
              })
            }
            style={{ cursor: 'pointer' }}
          >
            {children}
          </a>
        )
      },
      img: function MarkdownImg({ src, alt, ...props }) {
        const resolvedSrc = useLocalImageSrc(
          src,
          filePath,
          undefined,
          imageRuntimeContext,
          imageAccess
        )
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
        if (hasMermaidCodeClass(className)) {
          return (
            <MermaidBlock
              content={String(children).trimEnd()}
              isDark={isDark}
              onExpand={expandMermaidDiagram}
            />
          )
        }
        return (
          <code className={className} {...props}>
            {children}
          </code>
        )
      }
    }
  }, [
    filePath,
    activateMarkdownLink,
    expandMermaidDiagram,
    isDark,
    isMac,
    imageRuntimeContext,
    markdownDocumentIndex,
    onOpenDocument,
    openFile,
    openMarkdownPreview,
    readWorktreeRouting,
    scrollToAnchor,
    setMarkdownViewMode,
    sourceOwner,
    resolvedSourceRuntimeEnvironmentId,
    sourceRoutingWorktreeId,
    worktreeRoot
  ])
}
