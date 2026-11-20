import { canStartHardWrappedPath } from './hard-wrapped-terminal-path-fragments'
import type { TerminalLinkBuffer, TerminalLinkBufferLine } from './terminal-link-buffer'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

// Same vertical frames as framed HTTP links, including ASCII `|` tables.
const VERTICAL_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
// File-link characters, plus `:` so a wrapped `:line:col` stays on the path.
const TABLE_PATH_FRAGMENT_CHAR = /[\p{L}\p{N}\p{M}._~@%+=:,/\\()[\]-]/u
// A cell this full is a hard wrap. Matches framed HTTP links, and still allows one padding space.
const MIN_TABLE_PATH_FILL_RATIO = 0.8
const MAX_TABLE_PATH_ROWS = 20
const BORDER_WRAPPED_LONG_EXTENSIONS = new Set(['markdown'])
const TEST_OR_SPEC_EXTENSIONS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts'])
// Stem -> allowed final extensions for a flush border cut (`widget.test` + `.ts`, `archive.tar` + `.gz`).
const COMPOUND_EXTENSION_CONTINUATIONS = new Map<string, ReadonlySet<string>>([
  ['d', new Set(['ts', 'tsx', 'mts', 'cts'])],
  ['min', new Set(['js', 'css', 'mjs', 'cjs'])],
  ['module', new Set(['css', 'scss', 'sass', 'less'])],
  ['spec', TEST_OR_SPEC_EXTENSIONS],
  ['stories', new Set(['ts', 'tsx', 'js', 'jsx', 'mdx', 'svelte'])],
  ['tar', new Set(['gz', 'bz2', 'xz', 'zst', 'lzma'])],
  ['test', TEST_OR_SPEC_EXTENSIONS]
])

type TranslatedLine = ReturnType<typeof translateLineWithColumns>

type CachedRow = {
  translated: TranslatedLine
  isWrapped: boolean
  lineLength: number
}

type FrameSpan = {
  leftIndex: number
  rightIndex: number
  leftColumn: number
  rightColumn: number
}

type PathSlice = { start: number; end: number }

function isTablePathFragmentChar(char: string): boolean {
  return TABLE_PATH_FRAGMENT_CHAR.test(char)
}

function isTablePathFragment(text: string): boolean {
  return text.length > 0 && /[\p{L}\p{N}]/u.test(text) && [...text].every(isTablePathFragmentChar)
}

function canStartTablePath(text: string): boolean {
  return canStartHardWrappedPath(text) || /[\\/]/.test(text)
}

function fileExtensionSuffix(text: string): string | null {
  return /\.([\p{L}\p{N}]+)$/u.exec(text)?.[1] ?? null
}

function isDottedExtensionBorderCut(ext: string, fragment: string): boolean {
  const body = /^\.([\p{L}\p{N}]+)(?::\d+(?::\d+)?)?$/u.exec(fragment)?.[1]
  return (
    body !== undefined &&
    (COMPOUND_EXTENSION_CONTINUATIONS.get(ext.toLowerCase())?.has(body.toLowerCase()) ?? false)
  )
}

// Once joined text ends in a file extension, only allow an unambiguous continuation of
// that token (`:line[:col]`, `/subpath`, a split tail like `.t` + `s:42:10`, a border-cut
// `.ts` after `widget.test`, or `.mark` + `down`). Never a separate row's path
// (`src/bar.ts`, `README.md`), a dotted file name (`.gitignore`, `.env`), a padded `.map`,
// or a prose tail (`nextword`).
function canContinueAfterFileExtension(
  ext: string,
  fragment: string,
  prevHasTrailingPadding: boolean
): boolean {
  if (/^:\d+(?::\d+)?$/.test(fragment) || /^[\\/]/.test(fragment)) {
    return true
  }
  // Padding means the name already ended, so the next dotted token is its own row.
  if (!prevHasTrailingPadding && isDottedExtensionBorderCut(ext, fragment)) {
    return true
  }
  const tailMatch = /^([\p{L}\p{N}]+)(?::\d+(?::\d+)?)?$/u.exec(fragment)
  if (!tailMatch) {
    return false
  }
  const tail = tailMatch[1] ?? ''
  const combinedLength = ext.length + tail.length
  if ((ext.length === 1 || !prevHasTrailingPadding) && combinedLength <= 4) {
    return true
  }
  // `.markdown` is past the four-character split. A full cell may finish it; a padded name may not.
  return (
    !prevHasTrailingPadding && BORDER_WRAPPED_LONG_EXTENSIONS.has(`${ext}${tail}`.toLowerCase())
  )
}

function sliceHasTrailingPadding(
  translated: TranslatedLine,
  span: FrameSpan,
  slice: PathSlice
): boolean {
  const fragmentEndColumn = translated.columns[slice.end]
  return fragmentEndColumn !== undefined && fragmentEndColumn < span.rightColumn
}

function frameSpans(translated: TranslatedLine): FrameSpan[] {
  const indexes: number[] = []
  for (let index = 0; index < translated.text.length; index++) {
    if (VERTICAL_FRAME_PATTERN.test(translated.text[index] ?? '')) {
      indexes.push(index)
    }
  }
  const spans: FrameSpan[] = []
  for (let index = 0; index + 1 < indexes.length; index++) {
    const leftIndex = indexes[index] ?? -1
    const rightIndex = indexes[index + 1] ?? -1
    const leftColumn = translated.columns[leftIndex]
    const rightColumn = translated.columns[rightIndex]
    if (leftColumn === undefined || rightColumn === undefined || rightColumn <= leftColumn) {
      continue
    }
    spans.push({ leftIndex, rightIndex, leftColumn, rightColumn })
  }
  return spans
}

function gapIsPadding(translated: TranslatedLine, span: FrameSpan, end: number): boolean {
  for (let index = end; index < span.rightIndex; index++) {
    if (!/\s/.test(translated.text[index] ?? '')) {
      return false
    }
  }
  return true
}

function fillsCell(translated: TranslatedLine, span: FrameSpan, slice: PathSlice): boolean {
  if (!gapIsPadding(translated, span, slice.end)) {
    return false
  }
  const contentStartColumn = translated.columns[span.leftIndex + 1]
  const fragmentStartColumn = translated.columns[slice.start]
  const fragmentEndColumn = translated.columns[slice.end]
  if (
    contentStartColumn === undefined ||
    fragmentStartColumn === undefined ||
    fragmentEndColumn === undefined
  ) {
    return false
  }
  const contentWidth = span.rightColumn - contentStartColumn
  const fragmentWidth = fragmentEndColumn - fragmentStartColumn
  return contentWidth > 0 && fragmentWidth / contentWidth >= MIN_TABLE_PATH_FILL_RATIO
}

function trailingPathSlice(translated: TranslatedLine, span: FrameSpan): PathSlice | null {
  let end = span.rightIndex
  while (end > span.leftIndex + 1 && /\s/.test(translated.text[end - 1] ?? '')) {
    end--
  }
  let start = end
  while (start > span.leftIndex + 1 && isTablePathFragmentChar(translated.text[start - 1] ?? '')) {
    start--
  }
  if (start >= end) {
    return null
  }
  const text = translated.text.slice(start, end)
  return canStartTablePath(text) ? { start, end } : null
}

function leadingPathSlice(
  translated: TranslatedLine,
  span: FrameSpan,
  startColumn: number
): PathSlice | null {
  let start = span.leftIndex + 1
  while (start < span.rightIndex && (translated.columns[start] ?? -1) < startColumn) {
    start++
  }
  if ((translated.columns[start] ?? -1) !== startColumn) {
    return null
  }
  let end = start
  while (end < span.rightIndex && isTablePathFragmentChar(translated.text[end] ?? '')) {
    end++
  }
  const text = translated.text.slice(start, end)
  return isTablePathFragment(text) ? { start, end } : null
}

function readRow(
  buffer: TerminalLinkBuffer,
  y: number,
  cache: Map<number, CachedRow | null>
): CachedRow | null {
  const cached = cache.get(y)
  if (cached !== undefined) {
    return cached
  }
  const line = buffer.getLine(y)
  const row = line ? toCachedRow(line) : null
  cache.set(y, row)
  return row
}

function toCachedRow(line: TerminalLinkBufferLine): CachedRow {
  return {
    translated: translateLineWithColumns(line),
    isWrapped: line.isWrapped,
    lineLength: line.length
  }
}

function spanAtColumns(row: CachedRow, leftColumn: number, rightColumn: number): FrameSpan | null {
  return (
    frameSpans(row.translated).find(
      (span) => span.leftColumn === leftColumn && span.rightColumn === rightColumn
    ) ?? null
  )
}

function toLogicalLine(
  pieces: { row: CachedRow; y: number; slice: PathSlice }[]
): WrappedLogicalLine {
  let text = ''
  const rows: WrappedLogicalLine['rows'] = []
  for (const piece of pieces) {
    const fragment = piece.row.translated.text.slice(piece.slice.start, piece.slice.end)
    rows.push({
      y: piece.y,
      text: fragment,
      sourceText: piece.row.translated.text,
      columns: piece.row.translated.columns.slice(piece.slice.start, piece.slice.end + 1),
      startIndex: text.length,
      isWrapped: piece.row.isWrapped,
      lineLength: piece.row.lineLength
    })
    text += fragment
  }
  return {
    text,
    rows,
    fingerprint: `table-file:${rows.map((row) => `${row.y}:${row.lineLength}:${row.sourceText}\0${row.text}`).join('\n')}`
  }
}

function candidateForCell(
  buffer: TerminalLinkBuffer,
  cache: Map<number, CachedRow | null>,
  startY: number,
  currentY: number,
  span: FrameSpan,
  startSlice: PathSlice,
  startRow: CachedRow
): WrappedLogicalLine | null {
  const startColumn = startRow.translated.columns[startSlice.start]
  if (startColumn === undefined || !fillsCell(startRow.translated, span, startSlice)) {
    return null
  }
  const pieces = [{ row: startRow, y: startY, slice: startSlice }]
  let text = startRow.translated.text.slice(startSlice.start, startSlice.end)
  let prevHasTrailingPadding = sliceHasTrailingPadding(startRow.translated, span, startSlice)
  let lastY = startY
  for (let rowY = startY + 1; rowY < startY + MAX_TABLE_PATH_ROWS; rowY++) {
    const row = readRow(buffer, rowY, cache)
    const nextSpan = row ? spanAtColumns(row, span.leftColumn, span.rightColumn) : null
    const nextSlice =
      row && nextSpan ? leadingPathSlice(row.translated, nextSpan, startColumn) : null
    if (!row || !nextSpan || !nextSlice) {
      break
    }
    const fragment = row.translated.text.slice(nextSlice.start, nextSlice.end)
    // A padded name must not swallow the next row's own file, flag, or sibling extension.
    const ext = fileExtensionSuffix(text)
    if (ext !== null && !canContinueAfterFileExtension(ext, fragment, prevHasTrailingPadding)) {
      break
    }
    pieces.push({ row, y: rowY, slice: nextSlice })
    text += fragment
    prevHasTrailingPadding = sliceHasTrailingPadding(row.translated, nextSpan, nextSlice)
    lastY = rowY
    if (!fillsCell(row.translated, nextSpan, nextSlice)) {
      break
    }
  }
  if (pieces.length < 2 || lastY < currentY) {
    return null
  }
  return toLogicalLine(pieces)
}

export function buildHardWrappedTableFileLogicalLineCandidates(
  buffer: TerminalLinkBuffer,
  bufferLineNumber: number
): WrappedLogicalLine[] {
  const currentY = bufferLineNumber - 1
  const current = buffer.getLine(currentY)
  if (!current || !VERTICAL_FRAME_PATTERN.test(current.translateToString(false))) {
    return []
  }
  const cache = new Map<number, CachedRow | null>()
  const candidates: WrappedLogicalLine[] = []
  const minY = Math.max(0, currentY - MAX_TABLE_PATH_ROWS + 1)
  for (let startY = currentY; startY >= minY; startY--) {
    const startRow = readRow(buffer, startY, cache)
    if (!startRow || !VERTICAL_FRAME_PATTERN.test(startRow.translated.text)) {
      break
    }
    for (const span of frameSpans(startRow.translated)) {
      const startSlice = trailingPathSlice(startRow.translated, span)
      if (!startSlice) {
        continue
      }
      const candidate = candidateForCell(
        buffer,
        cache,
        startY,
        currentY,
        span,
        startSlice,
        startRow
      )
      if (candidate) {
        candidates.push(candidate)
      }
    }
  }
  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
