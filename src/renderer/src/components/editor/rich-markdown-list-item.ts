import type { JSONContent, MarkdownRendererHelpers, RenderContext } from '@tiptap/core'
import { ListItem } from '@tiptap/extension-list'
import { applyContinuationIndent } from './rich-markdown-list-continuation-indent'

// Why: the serializer's indent helper prepends a fixed two spaces, which is the
// marker width only for a bullet or a single-digit ordered item.
const BASE_INDENT = 2

const baseRenderMarkdown = ListItem.config.renderMarkdown as (
  node: JSONContent,
  helpers: MarkdownRendererHelpers,
  context: RenderContext
) => string

function listStart(context: RenderContext): number {
  return Number(context.meta?.parentAttrs?.start ?? 1)
}

function markerWidth(context: RenderContext): number {
  if (context?.parentType !== 'orderedList') {
    return '- '.length
  }
  return `${listStart(context) + (context.index ?? 0)}. `.length
}

/**
 * Rewrites the item's marker when the list starts at zero, which CommonMark
 * allows and the base renderer reads as falsy.
 */
function withZeroStartMarker(rendered: string, context: RenderContext): string {
  if (context?.parentType !== 'orderedList' || listStart(context) !== 0) {
    return rendered
  }
  const index = context.index ?? 0
  const marker = `${index + 1}. `
  // Why: the marker opens the rendered item, so anchoring the swap there keeps a
  // matching run of digits in the item's own text untouched.
  return rendered.startsWith(marker) ? `${index}. ${rendered.slice(marker.length)}` : rendered
}

/**
 * Number of lines the item's own first paragraph occupies. The serializer leaves
 * that run unindented and indents every later child by a fixed two columns, so the
 * two runs need different treatment and only the paragraph's own line count
 * separates them.
 */
function paragraphLineCount(node: JSONContent): number {
  const first = Array.isArray(node.content) ? node.content[0] : undefined
  if ((first as { type?: string } | undefined)?.type !== 'paragraph') {
    return 1
  }
  const content = (first as { content?: { type?: string; text?: string }[] }).content ?? []
  // Why: a hard break renders `  \n`, so it adds a line the JSON carries no text for.
  const text = content
    .map((child) => (child.type === 'hardBreak' ? '\n' : (child.text ?? '')))
    .join('')
  return text.split('\n').length
}

export const RichMarkdownListItem = ListItem.extend({
  renderMarkdown: (node, helpers, context) => {
    const width = markerWidth(context)
    const lines = withZeroStartMarker(baseRenderMarkdown(node, helpers, context), context).split(
      '\n'
    )
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
