import {
  createMarkdownFenceTracker,
  findMarkdownLineEnd,
  forEachMarkdownLine
} from './markdown-fence-scanner'

const BLANK_LINE = /^[ \t\r]*$/
const BLOCKQUOTE_PREFIX = /^(?: {0,3}>[ \t]?)+/

// Match marked’s block tags: div interrupts a paragraph, while br stays inline.
const HTML_BLOCK_TAG =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul'

// These single-line blocks force the next line into a new block.
const SINGLE_LINE_BLOCK =
  /^ {0,3}(?:#{1,6}(?:\s|$)|(?:-[\t ]*){3,}$|(?:_[ \t]*){3,}$|(?:\*[ \t]*){3,}$|(?:=+|-+)[ \t]*$)/

// Match marked’s paragraph interruptions so backticks cannot pair across leaf blocks.
const LEAF_BLOCK_START = new RegExp(
  [
    '^ {0,3}(?:',
    // Later ordinals open list items even though only 1 interrupts paragraphs; extra splitting only costs a check.
    '(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|$)',
    `|</?(?:${HTML_BLOCK_TAG})(?: +|/?>|$)`,
    '|<(?:script|pre|style|textarea|!--)', // a declaration or PI does not interrupt
    ')'
  ].join(''),
  'i'
)

// marked recognizes a GFM delimiter row before validating cell counts and ends the preceding paragraph.
const TABLE_DELIMITER_ROW = /^(?=[^\n]*[:|]) {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?$/

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

function hasTableDelimiterAhead(content: string, start: number): boolean {
  if (start >= content.length) {
    return false
  }
  const next = content.slice(start, findMarkdownLineEnd(content, start))
  return TABLE_DELIMITER_ROW.test(splitBlockquotePrefix(next).rest)
}

function isEscapedAt(content: string, index: number, lineStart: number): boolean {
  let cursor = index
  while (cursor > lineStart && content[cursor - 1] === '\\') {
    cursor -= 1
  }
  return (index - cursor) % 2 === 1
}

export type MarkdownCodeSpanScanner = {
  /** Return the closing offset only for a run matching the opener’s exact length, as CommonMark requires. */
  findSpanEnd: (index: number) => number | null
}

/** Index backtick runs once so each lookup binary-searches instead of rescanning the remaining document. */
export function createMarkdownCodeSpanScanner(content: string): MarkdownCodeSpanScanner {
  const starts: number[] = []
  const lengths: number[] = []
  // marked pairs backticks only within one leaf block, excluding blank lines, fences and new blocks.
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
      // Resume within rejected runs; escaped backticks cannot open but marked permits them to close a span.
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

export function skipMarkdownBacktickRun(content: string, index: number): number {
  let end = index
  while (content[end] === '`') {
    end += 1
  }
  return end
}
