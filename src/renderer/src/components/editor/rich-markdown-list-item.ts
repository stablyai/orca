import type { MarkdownNode, MarkdownRenderHelpers } from '@tiptap/core'
import { ListItem } from '@tiptap/extension-list'
import { applyContinuationIndent } from './rich-markdown-list-continuation-indent'

type RenderContext = {
  parentType?: string
  index?: number
  meta?: { parentAttrs?: { start?: number } }
}

// Why: the serializer's indent helper prepends a fixed two spaces, which is the
// marker width only for a bullet or a single-digit ordered item.
const BASE_INDENT = 2

const baseRenderMarkdown = ListItem.config.renderMarkdown as (
  node: MarkdownNode,
  helpers: MarkdownRenderHelpers,
  context: RenderContext
) => string

function markerWidth(context: RenderContext): number {
  if (context?.parentType !== 'orderedList') {
    return '- '.length
  }
  const start = context.meta?.parentAttrs?.start ?? 1
  return `${start + (context.index ?? 0)}. `.length
}

/**
 * Number of lines the item's own first paragraph occupies. The serializer leaves
 * that run unindented and indents every later child by a fixed two columns, so the
 * two runs need different treatment and only the paragraph's own line count
 * separates them.
 */
function paragraphLineCount(node: MarkdownNode): number {
  const first = Array.isArray(node.content) ? node.content[0] : undefined
  if ((first as { type?: string } | undefined)?.type !== 'paragraph') {
    return 1
  }
  const content = (first as { content?: { text?: string }[] }).content ?? []
  const text = content.map((child) => child.text ?? '').join('')
  return text.split('\n').length
}

export const RichMarkdownListItem = ListItem.extend({
  renderMarkdown: (node, helpers, context: RenderContext) => {
    const width = markerWidth(context)
    const lines = baseRenderMarkdown(node, helpers, context).split('\n')
    const blockStart = paragraphLineCount(node)
    // Why: the serializer never indents the newlines inside the item's own first
    // paragraph, and indents every later child by a fixed two columns.
    const paragraph = applyContinuationIndent(lines.slice(0, blockStart).join('\n'), width)
    const blocks = lines
      .slice(blockStart)
      .map((line) => (line === '' ? line : `${' '.repeat(width - BASE_INDENT)}${line}`))
    return [paragraph, ...blocks].join('\n')
  }
})
