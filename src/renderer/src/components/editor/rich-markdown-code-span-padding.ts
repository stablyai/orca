import { createMarkBoundaryWalkExtension } from './rich-markdown-mark-boundary-walk'
import type { MarkdownNodeLike } from './rich-markdown-mark-boundary-walk'

// Why: a private-use code point the serializer does not itself reserve — upstream
// builds its mark-delimiter probe out of U+E000 and U+E001.
const PADDING_SENTINEL = String.fromCharCode(0xe002)
// Why: the sentinel carries the code unit it hid, so a tab or a non-breaking space
// comes back as itself rather than as an ASCII space.
const MASKED_PADDING = new RegExp(`${PADDING_SENTINEL}([\\s\\S])${PADDING_SENTINEL}`, 'g')

function hasCodeMark(node: MarkdownNodeLike): boolean {
  return (node.marks ?? []).some(
    (mark) => (typeof mark === 'string' ? mark : mark?.type) === 'code'
  )
}

/**
 * Each padding character fenced by a sentinel on both sides, so restoring returns the
 * original code unit. Both sides are fenced because the walk strips a leading run and
 * a trailing run, so neither end of a masked run may be a character `\s` matches.
 */
function mask(padding: string): string {
  return Array.from(
    padding,
    (character) => `${PADDING_SENTINEL}${character}${PADDING_SENTINEL}`
  ).join('')
}

/**
 * Hides a code span's leading and trailing whitespace from the mark-boundary walk.
 * The walk strips whitespace off a marked run and re-appends it outside the
 * delimiters, which is right for emphasis (`** text **` is not emphasis) and wrong
 * for a code span, where CommonMark strips one pad on render and the source keeps
 * its bytes. A text already carrying the sentinel is left alone, because masking it
 * could not be told apart from the mask on the way back.
 */
export function maskCodeSpanPadding(nodes: MarkdownNodeLike[]): MarkdownNodeLike[] {
  return nodes.map((node) => {
    if (node?.type !== 'text' || !hasCodeMark(node)) {
      return node
    }
    const text = node.text ?? ''
    if (text.includes(PADDING_SENTINEL)) {
      return node
    }
    // Why: one match partitions the text, so an all-whitespace span cannot have its
    // padding counted as both leading and trailing.
    const [, leading = '', body = '', trailing = ''] = text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? []
    if (!leading && !trailing) {
      return node
    }
    return { ...node, text: mask(leading) + body + mask(trailing) }
  })
}

export function restoreCodeSpanPadding(markdown: string): string {
  return markdown.replace(MASKED_PADDING, '$1')
}

/**
 * Keeps a code span's padding inside its backticks.
 */
export const RichMarkdownCodeSpanPadding = createMarkBoundaryWalkExtension({
  name: 'richMarkdownCodeSpanPadding',
  rewriteNodes: maskCodeSpanPadding,
  rewriteOutput: restoreCodeSpanPadding
})
