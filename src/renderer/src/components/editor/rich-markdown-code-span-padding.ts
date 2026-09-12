import { createMarkBoundaryWalkExtension } from './rich-markdown-mark-boundary-walk'
import type { MarkdownNodeLike } from './rich-markdown-mark-boundary-walk'

// Why: a private-use code point the serializer does not itself reserve — upstream
// builds its mark-delimiter probe out of U+E000 and U+E001.
const PADDING_SENTINEL = String.fromCharCode(0xe002)

function hasCodeMark(node: MarkdownNodeLike): boolean {
  return (node.marks ?? []).some(
    (mark) => (typeof mark === 'string' ? mark : mark?.type) === 'code'
  )
}

/**
 * One mask-and-restore pair. Restoration only unwraps the marks this session
 * generated, counted in the order the walk emits them, so a sentinel the document
 * already contained survives rather than being read as a mask.
 */
export type CodeSpanPaddingSession = {
  mask: (nodes: MarkdownNodeLike[]) => MarkdownNodeLike[]
  restore: (markdown: string) => string
}

/**
 * Each padding character fenced by a sentinel on both sides, so restoring returns the
 * original code unit. Both sides are fenced because the walk strips a leading run and
 * a trailing run, so neither end of a masked run may be a character `\s` matches.
 */
function maskPadding(padding: string, generated: string[]): string {
  return Array.from(padding, (character) => {
    const fenced = `${PADDING_SENTINEL}${character}${PADDING_SENTINEL}`
    generated.push(fenced)
    return fenced
  }).join('')
}

/**
 * Hides a code span's leading and trailing whitespace from the mark-boundary walk.
 * The walk strips whitespace off a marked run and re-appends it outside the
 * delimiters, which is right for emphasis (`** text **` is not emphasis) and wrong
 * for a code span, where CommonMark strips one pad on render and the source keeps
 * its bytes.
 */
export function createCodeSpanPaddingSession(): CodeSpanPaddingSession {
  const generated: string[] = []
  return {
    mask: (nodes) =>
      nodes.map((node) => {
        if (node?.type !== 'text' || !hasCodeMark(node)) {
          return node
        }
        const text = node.text ?? ''
        // Why: one match partitions the text, so an all-whitespace span cannot have
        // its padding counted as both leading and trailing.
        const [, leading = '', body = '', trailing = ''] =
          text.match(/^(\s*)([\s\S]*?)(\s*)$/) ?? []
        if (!leading && !trailing) {
          return node
        }
        return {
          ...node,
          text: maskPadding(leading, generated) + body + maskPadding(trailing, generated)
        }
      }),
    restore: (markdown) => {
      let output = ''
      let cursor = 0
      for (const fenced of generated) {
        const at = markdown.indexOf(fenced, cursor)
        if (at === -1) {
          continue
        }
        output += markdown.slice(cursor, at) + fenced.slice(1, -1)
        cursor = at + fenced.length
      }
      return output + markdown.slice(cursor)
    }
  }
}

/**
 * Keeps a code span's padding inside its backticks.
 */
export const RichMarkdownCodeSpanPadding = createMarkBoundaryWalkExtension({
  name: 'richMarkdownCodeSpanPadding',
  createSession: createCodeSpanPaddingSession
})
