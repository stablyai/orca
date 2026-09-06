import type { MarkdownTokenizer } from '@tiptap/core'
import { OrderedList } from '@tiptap/extension-list'

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer

export const RichMarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list.
      if (typeof baseTokenizer.start === 'function' && baseTokenizer.start(src) !== 0) {
        return undefined
      }
      return baseTokenizer.tokenize(src, tokens, lexer)
    }
  }
})
