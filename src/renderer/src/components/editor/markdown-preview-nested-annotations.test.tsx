// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { MarkdownPreviewBody } from './MarkdownPreviewBody'
import { useMarkdownPreviewAnnotationRenderers } from './use-markdown-preview-annotation-renderers'
import type { MarkdownPreviewFoundation } from './use-markdown-preview-foundation'
import type { MarkdownPreviewReviewActions } from './use-markdown-preview-review-actions'

vi.mock('../diff-comments/DiffCommentCard', () => ({
  DiffCommentCard: ({ body }: { body: string }) => <div>{body}</div>
}))

function AnnotatedPreview({ content }: { content: string }) {
  // SAFETY: this static render only reads the annotation fields supplied here.
  const foundation = {
    sourceWorktree: { id: 'folder' },
    sourceRelativePath: 'notes.md',
    renderedContent: content
  } as MarkdownPreviewFoundation
  // SAFETY: callbacks for user interactions are unused during static rendering.
  const reviewActions = {
    getMarkdownCommentsForRange: ({ startLine, endLine }) =>
      startLine <= 1 && endLine >= 1
        ? [{ id: 'note', lineNumber: 1, body: 'Review this quote' }]
        : []
  } as MarkdownPreviewReviewActions
  const { wrapAnnotatedBlock } = useMarkdownPreviewAnnotationRenderers({
    foundation,
    reviewActions,
    filePath: '/notes.md',
    content,
    markdownAnnotationsEnabled: true
  })
  return (
    <MarkdownPreviewBody
      content={content}
      components={{
        h1: ({ node, children }) => wrapAnnotatedBlock('h1', node, <h1>{children}</h1>),
        p: ({ node, children }) => wrapAnnotatedBlock('p', node, <p>{children}</p>),
        blockquote: ({ node, children }) =>
          wrapAnnotatedBlock('blockquote', node, <blockquote>{children}</blockquote>)
      }}
    />
  )
}

describe('nested markdown preview annotations', () => {
  it.each([
    '> Quoted paragraph',
    '> > Nested quote',
    '> # Quoted heading',
    '> First paragraph\n>\n> Second paragraph'
  ])('renders a quoted note once with reachable controls: %s', (content) => {
    const container = document.createElement('div')
    container.innerHTML = renderToStaticMarkup(<AnnotatedPreview content={content} />)
    expect(container.querySelectorAll('[data-markdown-review-note-id="note"]')).toHaveLength(1)
    expect(container.querySelector('blockquote .markdown-annotation-block')).not.toBeNull()
    expect(
      container.querySelector('.markdown-annotation-block .markdown-annotation-block')
    ).toBeNull()
    expect(container.querySelectorAll('button[aria-label="Add note"]')).toHaveLength(
      content.includes('Second paragraph') ? 2 : 1
    )
  })
})
