import type { MarkdownParseResult, MarkdownToken, MarkdownTokenizer } from '@tiptap/core'
import { OrderedList, ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'

const orderedListStart = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s`)
const zeroOrderedListStart = /^\s*0[.)]\s/

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer
const baseParseMarkdown = OrderedList.config.parseMarkdown

function withZeroStart(parsed: MarkdownParseResult, token: MarkdownToken): MarkdownParseResult {
  if (
    token.start !== 0 ||
    !parsed ||
    Array.isArray(parsed) ||
    !('type' in parsed) ||
    parsed.type !== 'orderedList'
  ) {
    return parsed
  }
  return {
    ...parsed,
    attrs: {
      ...parsed.attrs,
      start: 0
    }
  }
}

export const RichMarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list.
      if (!orderedListStart.test(src)) {
        return undefined
      }
      const token = baseTokenizer.tokenize(src, tokens, lexer)
      if (zeroOrderedListStart.test(src) && token && typeof token === 'object') {
        token.start = 0
      }
      return token
    }
  },
  parseMarkdown: (token, helpers) => {
    const parsed = baseParseMarkdown?.(token, helpers)
    if (!parsed) {
      return []
    }
    return withZeroStart(parsed, token)
  }
})
