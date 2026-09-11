import { Extension } from '@tiptap/core'

// Why: a private-use code point cannot appear in a markdown document, so it can stand
// in for padding while the mark-boundary walk runs and be restored afterwards.
const PADDING_PLACEHOLDER = String.fromCharCode(0xe000)

type MarkdownNodeLike = {
  type?: string
  text?: string
  marks?: (string | { type?: string })[]
}

type BoundaryWalk = (nodes: MarkdownNodeLike[], ...rest: unknown[]) => unknown

function hasCodeMark(node: MarkdownNodeLike): boolean {
  return (node.marks ?? []).some(
    (mark) => (typeof mark === 'string' ? mark : mark?.type) === 'code'
  )
}

/**
 * Swaps a code span's leading and trailing spaces for a placeholder. The walk
 * strips whitespace off a marked run and re-appends it outside the delimiters,
 * which is right for emphasis (`** text **` is not emphasis) and wrong for a code
 * span, where CommonMark strips one pad on render and the source keeps its bytes.
 */
export function maskCodeSpanPadding(nodes: MarkdownNodeLike[]): MarkdownNodeLike[] {
  return nodes.map((node) => {
    if (node?.type !== 'text' || !hasCodeMark(node)) {
      return node
    }
    const text = node.text ?? ''
    const leading = text.match(/^(\s+)/)?.[1] ?? ''
    const trailing = text.match(/(\s+)$/)?.[1] ?? ''
    if (!leading && !trailing) {
      return node
    }
    const body = text.slice(leading.length, trailing ? text.length - trailing.length : text.length)
    return {
      ...node,
      text:
        PADDING_PLACEHOLDER.repeat(leading.length) +
        body +
        PADDING_PLACEHOLDER.repeat(trailing.length)
    }
  })
}

export function restoreCodeSpanPadding(markdown: string): string {
  return markdown.split(PADDING_PLACEHOLDER).join(' ')
}

/**
 * Keeps a code span's padding inside its backticks. Registered at the lowest
 * priority so it runs after `Markdown` publishes the manager on the editor.
 */
export const RichMarkdownCodeSpanPadding = Extension.create({
  name: 'richMarkdownCodeSpanPadding',
  priority: 1,

  onBeforeCreate() {
    const manager = this.editor.markdown as unknown as Record<string, unknown> | undefined
    if (!manager) {
      return
    }
    const prototype = Object.getPrototypeOf(manager) as Record<string, unknown>
    const walk = prototype.renderNodesWithMarkBoundaries as BoundaryWalk | undefined
    if (typeof walk !== 'function') {
      return
    }
    manager.renderNodesWithMarkBoundaries = function (
      this: unknown,
      nodes: MarkdownNodeLike[],
      ...rest: unknown[]
    ) {
      const rendered = walk.call(this, maskCodeSpanPadding(nodes ?? []), ...rest)
      return typeof rendered === 'string' ? restoreCodeSpanPadding(rendered) : rendered
    } as BoundaryWalk
  }
})
