import type { IBufferLine } from '@xterm/xterm'
import { TERMINAL_HTTP_URL_MAX_LENGTH } from './terminal-http-link-limits'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

const HTTP_SCHEME_PATTERN = /https?:\/\//i
const HTTP_SCHEME_START_PATTERN = /^https?:\/\//i
const VERTICAL_LAYOUT_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
// Mirrors isHttpUrlBodyTerminator: the characters that end a URL token.
const URL_BODY_RUN_PATTERN = /^[^\s"'!*(){}|\\^<>`]*/
const URL_TRAILING_PUNCTUATION_PATTERN = /^[)\]}>.,;:!?'"`]*/
// Where a URL-aware wrapper is allowed to split a long URL (see the same
// suffix set in hard-wrapped-terminal-http-links).
const URL_BREAK_OPPORTUNITY_PATTERN = /[/?&=#%+:-]$/
// Why: a `Label: value` row is its own line of output, not URL continuation —
// the guard that #8832/#9100 established for edge-wrapped rows (#8832).
// Both spaced (`Label: v`) and unspaced (`Label:v`) forms count.
const LABEL_ROW_PATTERN = /^[^\s:/?&=#%+-][^\s:]*:(?:\s|\S|$)/
// A wrapped URL tail continues the URL's own character set. A row opening with
// a path root, a drive letter, or a relative prefix is a fresh path, not a tail
// (#8832); so is one holding characters a URL tail would have percent-encoded.
const PATH_ROW_START_PATTERN = /^(?:[/\\~]|\.{1,2}[/\\]|[A-Za-z]:[/\\])/
const URL_TAIL_CHARSET_PATTERN = /^[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/
// A row that is only `#token`: a Markdown anchor or heading, not a URL fragment.
const MARKDOWN_ANCHOR_ROW_PATTERN = /^#/
const MAX_BLOCK_WRAPPED_ROWS = 30
const BLOCK_WIDTH_SCAN_ROWS = 40
// Why: a wrapper breaks a URL only once the row is nearly used up. A URL row
// ending far short of the block width ended because the URL did, so joining
// the next row would recreate #8832.
const MAX_UNUSED_COLUMN_RATIO = 0.25

type BlockRow = {
  text: string
  columns: number[]
  isWrapped: boolean
  lineLength: number
  contentStart: number
  contentEnd: number
  startColumn: number
  endColumn: number
}

type LeadingUrlFragment = {
  runText: string
  runEnd: number
  /** Display width of the unbreakable token (run plus trailing punctuation). */
  tokenWidth: number
}

function translateBlockRow(line: IBufferLine): BlockRow | null {
  const translated = translateLineWithColumns(line)
  const contentStart = translated.text.search(/\S/)
  if (contentStart === -1) {
    return null
  }
  let contentEnd = translated.text.length
  while (contentEnd > contentStart && /\s/.test(translated.text[contentEnd - 1])) {
    contentEnd--
  }
  return {
    text: translated.text,
    columns: translated.columns,
    isWrapped: line.isWrapped,
    lineLength: line.length,
    contentStart,
    contentEnd,
    startColumn: translated.columns[contentStart] ?? contentStart,
    endColumn: translated.columns[contentEnd] ?? contentEnd
  }
}

function isAsciiWordCode(code: number): boolean {
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    code === 95 ||
    (code >= 97 && code <= 122)
  )
}

/**
 * The last URL on the row — only that one can run into the wrap. An earlier,
 * already-complete URL on the same row must not shadow it.
 */
function findHttpSchemeIndex(text: string): number {
  let searchStart = 0
  let lastIndex = -1
  while (searchStart < text.length) {
    const relativeIndex = text.slice(searchStart).search(HTTP_SCHEME_PATTERN)
    if (relativeIndex === -1) {
      return lastIndex
    }
    const schemeIndex = searchStart + relativeIndex
    if (schemeIndex === 0 || !isAsciiWordCode(text.charCodeAt(schemeIndex - 1))) {
      lastIndex = schemeIndex
    }
    searchStart = schemeIndex + 1
  }
  return lastIndex
}

/**
 * The URL token must occupy the rest of the row for the row to have wrapped:
 * anything after it means the URL already ended on this row.
 */
function urlRunReachesRowEnd(row: BlockRow, schemeIndex: number): boolean {
  const run = row.text.slice(schemeIndex, row.contentEnd).match(URL_BODY_RUN_PATTERN)?.[0] ?? ''
  return run.length > 0 && schemeIndex + run.length === row.contentEnd
}

/**
 * The row's first token, when it reads as URL body. The token must end at
 * whitespace, at the row end, or at trailing punctuation followed by
 * whitespace — a token cut short by a URL-hostile character mid-word (a
 * Windows path's backslash, say) is not a wrapped URL continuation.
 *
 * Anything following the token must itself contain a URL. A wrapped tail is
 * either the end of the line or is followed by the next link in a list, the way
 * an agent prints one; plain prose after it means the row is its own sentence
 * that merely opens with a slash-bearing word — a date, a path, an `and/or`
 * (#8832).
 */
function leadingUrlFragment(row: BlockRow): LeadingUrlFragment | null {
  const content = row.text.slice(row.contentStart, row.contentEnd)
  const runText = content.match(URL_BODY_RUN_PATTERN)?.[0] ?? ''
  if (!runText) {
    return null
  }
  const remainder = content.slice(runText.length)
  const tail = remainder.match(URL_TRAILING_PUNCTUATION_PATTERN)?.[0] ?? ''
  const after = remainder.slice(tail.length)
  if (after.trim() !== '' && findHttpSchemeIndex(after) === -1) {
    return null
  }

  const tokenEnd = row.contentStart + runText.length + tail.length
  const tokenEndColumn = row.columns[tokenEnd] ?? tokenEnd
  return {
    runText,
    runEnd: row.contentStart + runText.length,
    tokenWidth: tokenEndColumn - row.startColumn
  }
}

function toLogicalRow(
  row: BlockRow,
  y: number,
  startIndex: number,
  endIndex: number,
  logicalStartIndex: number
): WrappedLogicalLine['rows'][number] {
  return {
    y,
    text: row.text.slice(startIndex, endIndex),
    sourceText: row.text,
    columns: row.columns.slice(startIndex, endIndex + 1),
    startIndex: logicalStartIndex,
    isWrapped: row.isWrapped,
    lineLength: row.lineLength
  }
}

function toLogicalLine(rows: WrappedLogicalLine['rows'], text: string): WrappedLogicalLine {
  return {
    text,
    rows: [...rows],
    fingerprint: `block-http:${rows.map((row) => `${row.y}:${row.sourceText}`).join('\0')}`
  }
}

/**
 * Reconstruct URLs that a TUI wrapped at its own block width rather than at the
 * terminal edge (grok's markdown stream, for one). Such rows carry no xterm
 * wrap metadata and stop well short of the last column, so both the soft-wrap
 * and terminal-edge strategies miss them.
 *
 * A row only counts as a continuation when the break looks mechanical: the
 * block demonstrably extends past where the URL row stopped, yet the next row's
 * leading token would not have fit in the space that was left.
 */
export function buildBlockWrappedHttpLogicalLineCandidates(
  buffer: { getLine(y: number): IBufferLine | undefined },
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const currentY = bufferLineNumber - 1
  if (!buffer.getLine(currentY)) {
    return []
  }

  const rowCache = new Map<number, BlockRow | null>()
  const getRow = (y: number): BlockRow | null => {
    if (rowCache.has(y)) {
      return rowCache.get(y) ?? null
    }
    const line = y < 0 ? undefined : buffer.getLine(y)
    const row = line ? translateBlockRow(line) : null
    rowCache.set(y, row)
    return row
  }

  // Why: the block width is witnessed by the *nearest* row that runs past the
  // URL row, not the widest row anywhere in the window. One unrelated wide line
  // (a full-terminal-width log entry, say) would otherwise inflate the estimate
  // until every genuine wrap looked like it had room to spare.
  const wrapColumnFor = (marginColumn: number, urlEndColumn: number, urlRowY: number): number => {
    for (let distance = 1; distance <= BLOCK_WIDTH_SCAN_ROWS; distance++) {
      let nearest = 0
      for (const y of [urlRowY - distance, urlRowY + distance]) {
        const row = getRow(y)
        if (row && row.startColumn === marginColumn && row.endColumn > urlEndColumn) {
          nearest = Math.max(nearest, row.endColumn)
        }
      }
      if (nearest > 0) {
        return nearest
      }
    }
    return 0
  }

  const candidates: WrappedLogicalLine[] = []
  const minY = Math.max(0, currentY - MAX_BLOCK_WRAPPED_ROWS + 1)
  for (let startY = currentY; startY >= minY; startY--) {
    const start = getRow(startY)
    if (!start || VERTICAL_LAYOUT_FRAME_PATTERN.test(start.text)) {
      continue
    }
    const schemeIndex = findHttpSchemeIndex(start.text)
    if (schemeIndex === -1 || !urlRunReachesRowEnd(start, schemeIndex)) {
      continue
    }
    const wrapColumn = wrapColumnFor(start.startColumn, start.endColumn, startY)
    // Why: a URL-aware wrapper splits only at a structural character. A row
    // ending mid-token ended because the URL ended, so joining the next row
    // would recreate #8832.
    if (!URL_BREAK_OPPORTUNITY_PATTERN.test(start.text.slice(0, start.contentEnd))) {
      continue
    }

    const previousRowEndsAtPathSeparator = start.text[start.contentEnd - 1] === '/'
    let text = start.text.slice(schemeIndex, start.contentEnd)
    const rows = [toLogicalRow(start, startY, schemeIndex, start.contentEnd, 0)]
    let previousEndColumn = start.endColumn
    for (let rowY = startY + 1; rowY <= startY + MAX_BLOCK_WRAPPED_ROWS; rowY++) {
      // Why: without a wider sibling row the block never demonstrates room to
      // the right of this URL, so nothing shows the break was a wrap. Relaxing
      // this to allow an equal-width row reopens #8832 for prose continuations.
      if (wrapColumn <= previousEndColumn) {
        break
      }
      const blockWidth = wrapColumn - start.startColumn
      if (wrapColumn - previousEndColumn > blockWidth * MAX_UNUSED_COLUMN_RATIO) {
        break
      }
      const next = getRow(rowY)
      if (!next || next.startColumn !== start.startColumn) {
        break
      }
      if (VERTICAL_LAYOUT_FRAME_PATTERN.test(next.text)) {
        break
      }
      const nextContent = next.text.slice(next.contentStart, next.contentEnd)
      // Why: `Label: value`, `Label:value`, and a fresh path root are all their
      // own line of output rather than a URL tail (#8832).
      if (LABEL_ROW_PATTERN.test(nextContent) || PATH_ROW_START_PATTERN.test(nextContent)) {
        break
      }
      const fragment = leadingUrlFragment(next)
      if (!fragment || HTTP_SCHEME_START_PATTERN.test(fragment.runText)) {
        break
      }
      // Why: a wrapped tail keeps to URL characters. It need not contain URL
      // punctuation — a bare last path segment is legal — because
      // leadingUrlFragment has already established the token is the whole row.
      if (!URL_TAIL_CHARSET_PATTERN.test(fragment.runText)) {
        break
      }
      // Why: a fragment attaches to a resource, so a wrap never leaves `/` at
      // the end of one row and `#` at the start of the next. A lone `#token`
      // row is a Markdown anchor or heading of its own.
      if (previousRowEndsAtPathSeparator && MARKDOWN_ANCHOR_ROW_PATTERN.test(fragment.runText)) {
        break
      }
      // Why: a token spanning the block's full width would not have fit on any
      // row, so its position says nothing about where the previous row ended.
      if (fragment.tokenWidth >= wrapColumn - start.startColumn) {
        break
      }
      // Why: the tail is one unbreakable token to a word wrapper, so it moved
      // down whole. Had it fit in the space left on the previous row the
      // wrapper would have kept it there — so these are two lines (#8832).
      if (previousEndColumn + fragment.tokenWidth <= wrapColumn) {
        break
      }
      if (text.length + fragment.runText.length > TERMINAL_HTTP_URL_MAX_LENGTH) {
        break
      }

      rows.push(toLogicalRow(next, rowY, next.contentStart, fragment.runEnd, text.length))
      text += fragment.runText
      if (rowY >= currentY) {
        candidates.push(toLogicalLine(rows, text))
      }
      if (fragment.runEnd !== next.contentEnd) {
        break
      }
      previousEndColumn = next.endColumn
    }
  }

  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
