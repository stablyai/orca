import type {
  MarkdownParseHelpers,
  MarkdownParseResult,
  MarkdownToken,
  MarkdownTokenizer
} from '@tiptap/core'
import { OrderedList, ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'
import type { Lexer } from 'marked'
import { tokenizeOrderedList } from './rich-markdown-ordered-list-structure'

const orderedListStart = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s`)

const numericDotStart = /^\s*\d+\.\s/

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer
const baseParseMarkdown = OrderedList.config.parseMarkdown as (
  token: MarkdownToken,
  helpers: MarkdownParseHelpers
) => MarkdownParseResult

type OrderedListNode = { type?: string; attrs?: Record<string, unknown> }

/**
 * CommonMark allows an ordered list to start at zero, which the base handler
 * drops because it reads the start value as falsy.
 */
function withParsedStart(parsed: MarkdownParseResult, start: unknown): MarkdownParseResult {
  if (typeof start !== 'number' || start === 1) {
    return parsed
  }
  const node = parsed as OrderedListNode
  if (node?.type !== 'orderedList') {
    return parsed
  }
  return { ...node, attrs: { ...node.attrs, start } }
}

export const RichMarkdownOrderedList = OrderedList.extend({
  markdownTokenizer: {
    ...baseTokenizer,
    tokenize(src, tokens, lexer) {
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list.
      if (!orderedListStart.test(src)) {
        return undefined
      }
      // Why: the structural tokenizer reads decimal markers only, so an alphabetic
      // or Roman list keeps its own nesting by going to the base tokenizer.
      if (!numericDotStart.test(src)) {
        return baseTokenizer.tokenize(src, tokens, lexer)
      }
      return tokenizeOrderedList(src, lexer as unknown as Lexer)
    }
  },

  parseMarkdown: (token: MarkdownToken, helpers: MarkdownParseHelpers) =>
    withParsedStart(baseParseMarkdown(token, helpers), token?.start)
})
