import type { MarkdownTokenizer } from '@tiptap/core'
import { OrderedList, ORDERED_LIST_MARKER_PATTERN } from '@tiptap/extension-list'

// Same as the base tokenizer's paragraph-interrupter patterns, which it does not export.
const paragraphInterrupters = [
  /^#{1,6}(?:\s|$)/,
  /^[-+*]\s+/,
  /^(?:```|~~~)/,
  /^\$\$/,
  /^(?:(?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})$/
]

const orderedListMarker = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]`)
const orderedListStart = new RegExp(`^\\s*(?:${ORDERED_LIST_MARKER_PATTERN})[.)]\\s`)
const lineTerminator = /[\n\r\u2028\u2029]/

/** Linear form of the base's item pattern `^(\s*)(marker)([.)])\s+(.*)$` (no m flag), which
 *  backtracks quadratically on long whitespace: `\s+` may cross line terminators, `.*` may not. */
function isOrderedListItem(line: string): boolean {
  const marker = orderedListMarker.exec(line)
  if (!marker) {
    return false
  }
  const rest = line.slice(marker[0].length)
  const content = rest.trimStart()
  return content.length < rest.length && !lineTerminator.test(content)
}

const baseTokenizer = OrderedList.config.markdownTokenizer as MarkdownTokenizer

/** The base tokenizer splits all remaining source into lines for every list, which is quadratic in
 *  large files. It always stops at an unindented, non-item line that interrupts a paragraph or comes
 *  after a blank line in the same item, so cut there. */
function boundOrderedListSource(src: string): string {
  let lineStart = src.indexOf('\n') + 1
  // Like the base, per item: a blank line anywhere in the item ends lazy continuation.
  let sawBlankLine = false
  while (lineStart > 0 && lineStart < src.length) {
    const lineEnd = src.indexOf('\n', lineStart)
    const line = src.slice(lineStart, lineEnd === -1 ? undefined : lineEnd)
    if (isOrderedListItem(line)) {
      sawBlankLine = false
    } else if (line.trim() === '') {
      sawBlankLine = true
    } else if (
      !/^\s/.test(line) &&
      (sawBlankLine || paragraphInterrupters.some((pattern) => pattern.test(line)))
    ) {
      // Exclude the newline too: a trailing empty line would join the list's raw source.
      return src.slice(0, lineStart - 1)
    }
    if (lineEnd === -1) {
      break
    }
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
      // Why: the base tokenizer scans the full remaining source before rejecting a non-list, and
      // accepts exactly when its first line is an item. Check the marker first: most calls are prose.
      if (!orderedListStart.test(src)) {
        return undefined
      }
      const firstLineEnd = src.indexOf('\n')
      if (!isOrderedListItem(firstLineEnd === -1 ? src : src.slice(0, firstLineEnd))) {
        return undefined
      }
      return baseTokenizer.tokenize(boundOrderedListSource(src), tokens, lexer)
    }
  }
})
