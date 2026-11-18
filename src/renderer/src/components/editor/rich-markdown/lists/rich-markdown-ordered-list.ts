import type { MarkdownTokenizer } from '@tiptap/core'
import { OrderedList, ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'

const orderedListStart = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s`)
// Same as the base tokenizer's item pattern, which it does not export.
const orderedListItem = new RegExp(`^(\\s*)(${ORDERED_LIST_MARKER_PATTERN})([.)])\\s+(.*)$`)

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer

/** The base tokenizer splits all remaining source into lines for every list, which is quadratic in
 *  large files. It always stops at an unindented, non-item line after a blank line, so cut there. */
function boundOrderedListSource(src: string): string {
  let lineStart = src.indexOf('\n') + 1
  let previousBlank = false
  while (lineStart > 0 && lineStart < src.length) {
    const lineEnd = src.indexOf('\n', lineStart)
    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    const blank = line.trim() === ''
    if (previousBlank && !blank && !/^\s/.test(line) && !orderedListItem.test(line)) {
      // Exclude the newline too: a trailing empty line would join the list's raw source.
      return src.slice(0, lineStart - 1)
    }
    if (lineEnd === -1) {
      break
    }
    previousBlank = blank
    lineStart = lineEnd + 1
  }
  return src
}

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
      return baseTokenizer.tokenize(boundOrderedListSource(src), tokens, lexer)
    }
  }
})
