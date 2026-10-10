import { Code } from '@tiptap/extension-code'
import type { JSONContent } from '@tiptap/core'

export function prepareMarkdownCodeSpans(node: JSONContent): void {
  let span: JSONContent[] = []
  let linkKey = ''
  const finishSpan = (): void => {
    if (span.length === 0) {
      return
    }
    const text = span.map((child) => child.text ?? '').join('')
    let longest = 0
    for (const match of text.matchAll(/`+/g)) {
      longest = Math.max(longest, match[0].length)
    }
    const delimiter = '`'.repeat(longest + 1)
    for (const child of span) {
      const mark = child.marks?.find((candidate) => candidate.type === 'code')
      if (mark) {
        // Serialization-only attributes keep link syntax outside code delimiters.
        mark.attrs = {
          ...mark.attrs,
          markdownLink: linkKey,
          markdownCodeDelimiter: delimiter
        }
      }
    }
    span = []
  }
  for (const child of node.content ?? []) {
    const isCode = child.type === 'text' && child.marks?.some((mark) => mark.type === 'code')
    const nextLinkKey = JSON.stringify(
      child.marks?.find((mark) => mark.type === 'link')?.attrs ?? null
    )
    if (!isCode || nextLinkKey !== linkKey) {
      finishSpan()
    }
    if (isCode) {
      span.push(child)
      linkKey = nextLinkKey
    }
    prepareMarkdownCodeSpans(child)
  }
  finishSpan()
}

export const RichMarkdownCode = Code.extend({
  // Markdown supports linked code labels without emphasis marks.
  excludes: 'code bold italic strike underline',
  renderMarkdown(node, helpers) {
    if (!node.content) {
      return ''
    }
    // Mark renderers receive synthetic content; delimiters come from the prepared span.
    const delimiter =
      typeof node.attrs?.markdownCodeDelimiter === 'string' ? node.attrs.markdownCodeDelimiter : '`'
    const padding = delimiter.length > 1 ? ' ' : ''
    return `${delimiter}${padding}${helpers.renderChildren(node.content)}${padding}${delimiter}`
  }
})
