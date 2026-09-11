import type { MarkdownTokenizer } from '@tiptap/core'
import { OrderedList } from '@tiptap/extension-list'
import { normalizeOrderedContinuationIndent } from './rich-markdown-list-continuation-indent'

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer

/**
 * Lines the list can reach, so normalization never rewrites the rest of the
 * document. A blank line followed by an unindented non-item line ends the list.
 */
function listExtent(source: string): number {
  const lines = source.split('\n')
  let index = 1
  let sawBlank = false
  while (index < lines.length) {
    const line = lines[index]
    if (line.trim() === '') {
      sawBlank = true
    } else if (/^\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      sawBlank = false
    } else if (sawBlank) {
      break
    }
    index += 1
  }
  return lines.slice(0, index).join('\n').length
}

export const RichMarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list.
      if (typeof baseTokenizer.start === 'function' && baseTokenizer.start(src) !== 0) {
        return undefined
      }
      // Why: the base tokenizer stops at the list's end, so handing it only that slice
      // keeps normalization off the rest of the document.
      const extent = listExtent(src)
      const token = baseTokenizer.tokenize(
        normalizeOrderedContinuationIndent(src.slice(0, extent)),
        tokens,
        lexer
      )
      if (token) {
        // Why: `raw` drives how much source the lexer consumes, so it must measure the
        // original text rather than the normalized copy.
        token.raw = src.slice(0, measureConsumed(src, token.raw as string))
      }
      return token
    }
  }
})

function measureConsumed(source: string, normalizedRaw: string): number {
  const lineCount = normalizedRaw.split('\n').length
  const lines = source.split('\n')
  return lines.slice(0, lineCount).join('\n').length
}
