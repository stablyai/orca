import type { MarkdownTokenizer } from '@tiptap/core'
import { OrderedList, ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'

const orderedListStart = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s`)

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer

export const RichMarkdownOrderedList = OrderedList.extend({
  addAttributes() {
    // Why: Markdown reads only numeric markers, so a lettered HTML paste shows and saves as "1."
    const { type: _letteredType, ...attributes } = this.parent?.() ?? {}
    return attributes
  },
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list.
      if (!orderedListStart.test(src)) {
        return undefined
      }
      return baseTokenizer.tokenize(src, tokens, lexer)
    }
  }
})
