import {
  createMarkdownFenceTracker,
  findMarkdownLineEnd,
  forEachMarkdownLine
} from './markdown-fence-scanner'

const BLANK_LINE = /^[ \t\r]*$/
const BLOCKQUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/

// marked's block-level tag list, which is what makes a line an HTML block rather
// than inline HTML: `<div>` ends the paragraph above it, `<br>` does not.
const HTML_BLOCK_TAG =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'

// Headings, thematic breaks, and setext underlines are one line each, so the line
// after them always opens another block.
const SINGLE_LINE_BLOCK =
  /^ {0,3}(?:#{1,6}(?:\s|$)|(?:-[\t ]*){3,}$|(?:_[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:=+|-+)[ \t]*$)/

// Mirrors the rest of marked's paragraph-interruption rule. Backtick runs on
// opposite sides of one of these lines sit in different leaf blocks, so marked
// never pairs them.
const LEAF_BLOCK_START = new RegExp(
  [
    '^ {0,3}(?:',
    // Any ordinal, though only `1.` interrupts a paragraph: later ordinals still open
    // the next item of a list, and splitting one block too many only costs a check.
    '(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)',
    `|</?(?:${HTML_BLOCK_TAG})(?: +|/?>|$)`,
    '|<(?:script|pre|style|textarea|!--)', // a declaration or PI does not interrupt
    ')'
  ].join(''),
  'i'
)

// The row of dashes under a GFM table header. marked ends the paragraph above the
// header on this line alone, before it checks that the cell counts agree.
const TABLE_DELIMITER_ROW = /^(?=[^\n]*[:|]) {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/

/** Blockquote marker count opening `line`, and the content that follows it. */
function splitBlockquotePrefix(line: string): { depth: number; rest: string } {
  const prefix = BLOCKQUOTE_PREFIX.exec(line)?.[0]
  if (!prefix) {
    return { depth: 0, rest: line }
  }
  let depth = 0
  for (const character of prefix) {
    if (character === '>') {
      depth += 1
    }
  }
  return { depth, rest: line.slice(prefix.length) }
}

/** True when the line at `start` is a delimiter row, making the line above a header. */
function hasTableDelimiterAhead(content: string, start: number): boolean {
  if (start >= content.length) {
    return false
  }
  const next = content.slice(start, findMarkdownLineEnd(content, start))
  return TABLE_DELIMITER_ROW.test(splitBlockquotePrefix(next).rest)
}

/** True when an odd run of backslashes escapes the character at `index`. */
function isEscapedAt(content: string, index: number, lineStart: number): boolean {
  let cursor = index
  while (cursor > lineStart && content[cursor - 1] === '\\') {
    cursor -= 1
  }
  return (index - cursor) % 2 === 1
}

export type MarkdownCodeSpanScanner = {
  /**
   * End of the inline code span opening at `index`, or null when the backtick run
   * never closes. CommonMark closes a span on a run of exactly the opening length,
   * so a longer run is content rather than a delimiter.
   */
  findSpanEnd: (index: number) => number | null
}

/**
 * Indexes every backtick run in one pass, so a lookup is a binary search rather
 * than a fresh scan of the rest of the document.
 */
export function createMarkdownCodeSpanScanner(content: string): MarkdownCodeSpanScanner {
  const starts: number[] = []
  const lengths: number[] = []
  // Marked parses inline content one leaf block at a time, so a span cannot pair
  // across a blank line, a fence delimiter, or the start of the next leaf block.
  const blocks: number[] = []
  const escaped: boolean[] = []
  const runsByLength = new Map<number, number[]>()

  const fence = createMarkdownFenceTracker()
  let blockId = 0
  let previousWasBoundary = true
  let previousQuoteDepth = 0
  let insideTable = false

  forEachMarkdownLine(content, (lineStart, lineEnd, nextLineStart) => {
    const line = content.slice(lineStart, lineEnd)
    const wasInsideFence = fence.insideFence
    const isBoundary = fence.consume(line) || wasInsideFence || BLANK_LINE.test(line)
    if (isBoundary) {
      insideTable = false
    }
    const quote = isBoundary ? null : splitBlockquotePrefix(line)
    const quoteDepth = quote ? quote.depth : previousQuoteDepth
    const isDelimiterRow = quote !== null && TABLE_DELIMITER_ROW.test(quote.rest)
    const isTableHeader =
      quote !== null && !isDelimiterRow && hasTableDelimiterAhead(content, nextLineStart)
    insideTable = insideTable || isDelimiterRow
    // marked parses every cell on its own, so each row is its own inline context.
    const endsWithLine =
      quote !== null && (SINGLE_LINE_BLOCK.test(quote.rest) || isTableHeader || insideTable)
    // A deeper quote opens a block; a shallower one can be a lazy continuation.
    const startsLeafBlock =
      quote !== null &&
      (endsWithLine || quote.depth > previousQuoteDepth || LEAF_BLOCK_START.test(quote.rest))
    if (isBoundary || previousWasBoundary || startsLeafBlock) {
      blockId += 1
    }
    previousWasBoundary = isBoundary || endsWithLine
    previousQuoteDepth = quoteDepth
    if (isBoundary) {
      return
    }

    let index = lineStart
    while (index < lineEnd) {
      if (content[index] !== '`') {
        index += 1
        continue
      }
      const runStart = index
      while (index < lineEnd && content[index] === '`') {
        index += 1
      }
      const runLength = index - runStart
      const runsOfLength = runsByLength.get(runLength)
      if (runsOfLength) {
        runsOfLength.push(starts.length)
      } else {
        runsByLength.set(runLength, [starts.length])
      }
      starts.push(runStart)
      lengths.push(runLength)
      blocks.push(blockId)
      escaped.push(isEscapedAt(content, runStart, lineStart))
    }
  })

  /** Index of the run covering `index`, or -1. */
  function findRunAt(index: number): number {
    let low = 0
    let high = starts.length - 1
    let atOrBefore = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (starts[mid] <= index) {
        atOrBefore = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    if (atOrBefore === -1 || index >= starts[atOrBefore] + lengths[atOrBefore]) {
      return -1
    }
    return atOrBefore
  }

  /** First run in `candidates` starting at or after `offset`, or -1. */
  function findFirstRunFrom(candidates: number[], offset: number): number {
    let low = 0
    let high = candidates.length - 1
    let match = -1
    while (low <= high) {
      const mid = (low + high) >> 1
      if (starts[candidates[mid]] >= offset) {
        match = candidates[mid]
        high = mid - 1
      } else {
        low = mid + 1
      }
    }
    return match
  }

  return {
    findSpanEnd(index: number): number | null {
      const opener = findRunAt(index)
      if (opener === -1) {
        return null
      }
      // A caller may resume inside a run it already rejected; only the tail opens.
      // A backslashed backtick is literal text and cannot open, though marked
      // still lets it close: `` `foo\` `` is a span ending on the escaped run.
      const openStart = escaped[opener] ? Math.max(index, starts[opener] + 1) : index
      const openerEnd = starts[opener] + lengths[opener]
      if (openStart >= openerEnd) {
        return null
      }
      const candidates = runsByLength.get(openerEnd - openStart)
      if (!candidates) {
        return null
      }
      const closer = findFirstRunFrom(candidates, openerEnd)
      if (closer === -1 || blocks[closer] !== blocks[opener]) {
        return null
      }
      return starts[closer] + lengths[closer]
    }
  }
}

/** Offsets of the run of backticks at `index`, which closes no span. */
export function skipMarkdownBacktickRun(content: string, index: number): number {
  let end = index
  while (content[end] === '`') {
    end += 1
  }
  return end
}
