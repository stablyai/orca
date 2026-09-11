import type { MarkdownTokenizer } from '@tiptap/core'
import { OrderedList } from '@tiptap/extension-list'
import { normalizeOrderedContinuationIndent } from './rich-markdown-list-continuation-indent'

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer

export const RichMarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list.
      if (typeof baseTokenizer.start === 'function' && baseTokenizer.start(src) !== 0) {
        return undefined
      }
      const token = baseTokenizer.tokenize(normalizeOrderedContinuationIndent(src), tokens, lexer)
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
