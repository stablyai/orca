import type { JSONContent, RenderContext } from '@tiptap/core'
import { ListItem } from '@tiptap/extension-list'

const BASE_INDENT = 2

const baseRenderMarkdown = ListItem.config.renderMarkdown

function listStart(context: RenderContext): number {
  const start = context.meta?.parentAttrs?.start
  return typeof start === 'number' ? start : 1
}

function markerWidth(context: RenderContext): number {
  if (context.parentType !== 'orderedList') {
    return 2
  }
  return `${listStart(context) + (context.index ?? 0)}. `.length
}

function renderZeroStartMarker(rendered: string, context: RenderContext): string {
  if (context.parentType !== 'orderedList' || listStart(context) !== 0) {
    return rendered
  }
  const index = context.index ?? 0
  const baseMarker = `${index + 1}. `
  return rendered.startsWith(baseMarker)
    ? `${index}. ${rendered.slice(baseMarker.length)}`
    : rendered
}

function paragraphLineCount(node: JSONContent): number {
  const first = Array.isArray(node.content) ? node.content[0] : undefined
  if (first?.type !== 'paragraph') {
    return 1
  }
  const text = (first.content ?? [])
    .map((child) => (child.type === 'hardBreak' ? '\n' : (child.text ?? '')))
    .join('')
  return text.split('\n').length
}

function indentParagraphContinuations(markdown: string, column: number): string {
  return markdown.replace(/\n(?!\n)[ \t]*/g, `\n${' '.repeat(column)}`)
}

function renderOrderedBlocks(lines: string[], width: number): string[] {
  let fence: { character: '`' | '~'; length: number } | null = null
  return lines.map((line) => {
    const trimmed = line.trimStart()
    const match = trimmed.match(/^(`{3,}|~{3,})(.*)$/)
    if (match) {
      const character = match[1].startsWith('`') ? '`' : '~'
      const length = match[1].length
      const closesFence =
        fence && fence.character === character && length >= fence.length && match[2].trim() === ''
      if (closesFence || !fence) {
        fence = closesFence ? null : { character, length }
      }
      return line
    }
    if (fence) {
      return line.startsWith(' ') ? line.slice(1) : line
    }
    return line === '' ? line : `${' '.repeat(Math.max(0, width - BASE_INDENT))}${line}`
  })
}

export const RichMarkdownListItem = ListItem.extend({
  renderMarkdown: (node, helpers, context) => {
    if (typeof baseRenderMarkdown !== 'function') {
      return ''
    }
    if (context.parentType !== 'orderedList') {
      return baseRenderMarkdown(node, helpers, context)
    }
    const width = markerWidth(context)
    const lines = renderZeroStartMarker(baseRenderMarkdown(node, helpers, context), context).split(
      '\n'
    )
    const paragraphLines = paragraphLineCount(node)
    const paragraph = indentParagraphContinuations(lines.slice(0, paragraphLines).join('\n'), width)
    const blocks = renderOrderedBlocks(lines.slice(paragraphLines), width)
    return [paragraph, ...blocks].join('\n')
  }
})
