import { canStartHardWrappedPath } from './hard-wrapped-terminal-path-fragments'
import type { TerminalLinkBuffer } from './terminal-link-buffer'
import { translateLineWithColumns, type WrappedLogicalLine } from './wrapped-terminal-link-ranges'

// Same vertical frames as framed HTTP links, including ASCII `|` tables.
const VERTICAL_FRAME_PATTERN = /[│┃║╎╏┆┇┊┋|]/
// File-link characters, plus `:` so a wrapped `:line:col` stays on the path.
const TABLE_PATH_FRAGMENT_CHAR = /[\p{L}\p{N}\p{M}._~@%+=:,/\\()[\]-]/u
// Share of the usable cell, after symmetric frame padding, that counts as a hard wrap.
const MIN_TABLE_PATH_FILL_RATIO = 0.8
const MAX_TABLE_PATH_ROWS = 20
const extSet = (s: string) => new Set(s.split(' '))
const BORDER_WRAPPED_LONG_EXTENSIONS = extSet(
  'astro cmake csproj gradle graphql groovy jsonl markdown ndjson plist podspec prisma properties proto scala svelte swift tfvars xhtml'
)
const TEST_OR_SPEC_EXTENSIONS = extSet('ts tsx js jsx mjs cjs mts cts')
// Stem -> allowed final extensions for a flush border cut (`widget.test` + `.ts`, `archive.tar` + `.gz`).
const COMPOUND_EXTENSION_CONTINUATIONS = new Map<string, ReadonlySet<string>>([
  ['d', extSet('ts tsx mts cts')],
  ['min', extSet('js css mjs cjs')],
  ['module', extSet('css scss sass less')],
  ['spec', TEST_OR_SPEC_EXTENSIONS],
  ['stories', extSet('ts tsx js jsx mdx svelte')],
  ['tar', extSet('gz bz2 xz zst lzma')],
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

// Horizontal rules, Markdown dividers, ellipses, and delimiter tokens must not join paths.
const TABLE_SEPARATOR_FRAGMENT = /^(?::?-+:?|=+|~{2,}|\.+|\+{3,}|_{3,}|(?=.*[-=~+])[-=_~.+:]{3,})$/
const RULE_MARK_TOKEN = /^[-=_~+]+$/

function isPunctuationTablePathFragment(text: string, cellRest: string): boolean {
  const core = text.replace(/[.,]+$/, '')
  if (core.length === 0 || /[()[\]:/\\]/.test(core) || TABLE_SEPARATOR_FRAGMENT.test(core)) {
    return false
  }
  if (!RULE_MARK_TOKEN.test(core)) {
    return true
  }
  const restTokens = cellRest.trimStart().split(/\s+/).filter(Boolean)
  let ruleTokens = 1
  let sameMark = [...core].every((char) => char === core[0])
  for (let index = 0; index < restTokens.length; index++) {
    const raw = restTokens[index] ?? ''
    if (/^[.,]$/.test(raw)) {
      if (RULE_MARK_TOKEN.test((restTokens[index + 1] ?? '').replace(/[.,;:!?)}\]]+$/, ''))) {
        continue
      }
      break
    }
    const nextCore = raw.replace(/[.,;:!?)}\]]+$/, '')
    if (nextCore.length === 0 || !RULE_MARK_TOKEN.test(nextCore)) {
      break
    }
    sameMark = sameMark && [...nextCore].every((char) => char === core[0])
    ruleTokens++
  }
  return sameMark && core !== '++' ? ruleTokens < 2 : ruleTokens < 3
}

function isTablePathFragment(text: string, cellRest: string): boolean {
  if (text.length === 0 || ![...text].every((char) => TABLE_PATH_FRAGMENT_CHAR.test(char))) {
    return false
  }
  return /[\p{L}\p{N}]/u.test(text) || isPunctuationTablePathFragment(text, cellRest)
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
  const dotted = /^\.([\p{L}\p{N}]+)(?::\d+(?::\d+)?)?$/u.exec(fragment)?.[1]
  if (
    !prevHasTrailingPadding &&
    dotted !== undefined &&
    COMPOUND_EXTENSION_CONTINUATIONS.get(ext.toLowerCase())?.has(dotted.toLowerCase())
  ) {
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

function sliceHasTrailingPadding(translated: TranslatedLine, span: FrameSpan, slice: PathSlice) {
  const endColumn = translated.columns[slice.end]
  return endColumn !== undefined && endColumn < span.rightColumn
}

function frameSpans(translated: TranslatedLine): FrameSpan[] {
  const spans: FrameSpan[] = []
  let leftIndex = -1
  for (let index = 0; index < translated.text.length; index++) {
    if (!VERTICAL_FRAME_PATTERN.test(translated.text[index] ?? '')) {
      continue
    }
    if (leftIndex >= 0) {
      const leftColumn = translated.columns[leftIndex]
      const rightColumn = translated.columns[index]
      if (leftColumn !== undefined && rightColumn !== undefined && rightColumn > leftColumn) {
        spans.push({ leftIndex, rightIndex: index, leftColumn, rightColumn })
      }
    }
    leftIndex = index
  }
  return spans
}

function fillsCell(translated: TranslatedLine, span: FrameSpan, slice: PathSlice): boolean {
  const { text, columns } = translated
  const [start, from, to] = [columns[span.leftIndex + 1], columns[slice.start], columns[slice.end]]
  if (start === undefined || from === undefined || to === undefined) {
    return false
  }
  if (!/^\s*$/.test(text.slice(slice.end, span.rightIndex))) {
    return false
  }
  // Subtract narrow symmetric cell padding (<= 2 terminal columns, left <= right) only when only
  // whitespace precedes the path fragment, so labeled, centered, right-aligned, or sparse cells
  // do not count as hard wraps.
  const leftPad = /^\s*$/.test(text.slice(span.leftIndex + 1, slice.start)) ? from - start : -1
  const pad = leftPad >= 0 && leftPad <= 2 && leftPad <= span.rightColumn - to ? leftPad : 0
  const usable = span.rightColumn - start - pad * 2
  return usable > 0 && (to - from) / usable >= MIN_TABLE_PATH_FILL_RATIO
}

function trailingPathSlice(translated: TranslatedLine, span: FrameSpan): PathSlice | null {
  let end = span.rightIndex
  while (end > span.leftIndex + 1 && /\s/.test(translated.text[end - 1] ?? '')) {
    end--
  }
  let start = end
  while (
    start > span.leftIndex + 1 &&
    TABLE_PATH_FRAGMENT_CHAR.test(translated.text[start - 1] ?? '')
  ) {
    start--
  }
  if (start >= end) {
    return null
  }
  const text = translated.text.slice(start, end)
  return canStartHardWrappedPath(text) || /[\\/]/.test(text) ? { start, end } : null
}

function leadingPathSlice(translated: TranslatedLine, span: FrameSpan, startColumn: number) {
  let start = span.leftIndex + 1
  while (start < span.rightIndex && (translated.columns[start] ?? -1) < startColumn) {
    start++
  }
  if (
    (translated.columns[start] ?? -1) !== startColumn ||
    !/^\s*$/.test(translated.text.slice(span.leftIndex + 1, start))
  ) {
    return null
  }
  let end = start
  while (end < span.rightIndex && TABLE_PATH_FRAGMENT_CHAR.test(translated.text[end] ?? '')) {
    end++
  }
  const text = translated.text.slice(start, end)
  return isTablePathFragment(text, translated.text.slice(end, span.rightIndex))
    ? { start, end }
    : null
}

function readRow(buffer: TerminalLinkBuffer, y: number, cache: Map<number, CachedRow | null>) {
  if (cache.has(y)) {
    return cache.get(y) ?? null
  }
  const line = buffer.getLine(y)
  const row = line
    ? {
        translated: translateLineWithColumns(line),
        isWrapped: line.isWrapped,
        lineLength: line.length
      }
    : null
  cache.set(y, row)
  return row
}

function toLogicalLine(
  pieces: { row: CachedRow; y: number; slice: PathSlice }[],
  span: FrameSpan
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
  // Row text repeats in every cell, so the cell's column span keeps each copy.
  return {
    text,
    rows,
    fingerprint: `table-file:${span.leftColumn}-${span.rightColumn}:${rows.map((row) => `${row.y}:${row.lineLength}:${row.sourceText}\0${row.text}`).join('\n')}`
  }
}

function candidatesForCell(
  buffer: TerminalLinkBuffer,
  cache: Map<number, CachedRow | null>,
  startY: number,
  currentY: number,
  span: FrameSpan,
  startSlice: PathSlice,
  startRow: CachedRow
): WrappedLogicalLine[] {
  const startColumn = startRow.translated.columns[startSlice.start]
  if (startColumn === undefined || !fillsCell(startRow.translated, span, startSlice)) {
    return []
  }
  const pieces = [{ row: startRow, y: startY, slice: startSlice }]
  const emitted: WrappedLogicalLine[] = []
  let text = startRow.translated.text.slice(startSlice.start, startSlice.end)
  let prevHasTrailingPadding = sliceHasTrailingPadding(startRow.translated, span, startSlice)
  let lastY = startY
  for (let rowY = startY + 1; rowY < startY + MAX_TABLE_PATH_ROWS; rowY++) {
    const row = readRow(buffer, rowY, cache)
    const nextSpan =
      row &&
      frameSpans(row.translated).find(
        (item) => item.leftColumn === span.leftColumn && item.rightColumn === span.rightColumn
      )
    const nextSlice =
      row && nextSpan ? leadingPathSlice(row.translated, nextSpan, startColumn) : null
    if (!row || !nextSpan || !nextSlice) {
      break
    }
    const fragment = row.translated.text.slice(nextSlice.start, nextSlice.end)
    // A padded name must not swallow the next row's own file, flag, or sibling extension.
    const ext = /\.([\p{L}\p{N}]+)$/u.exec(text)?.[1] ?? null
    if (ext !== null) {
      if (!canContinueAfterFileExtension(ext, fragment, prevHasTrailingPadding)) {
        break
      }
      // Keep the already-complete path alongside any extended candidate (`foo.ts` + `x`).
      if (pieces.length >= 2 && lastY >= currentY) {
        emitted.push(toLogicalLine(pieces, span))
      }
    }
    pieces.push({ row, y: rowY, slice: nextSlice })
    text += fragment
    prevHasTrailingPadding = sliceHasTrailingPadding(row.translated, nextSpan, nextSlice)
    lastY = rowY
    if (!fillsCell(row.translated, nextSpan, nextSlice)) {
      break
    }
  }
  if (pieces.length >= 2 && lastY >= currentY) {
    emitted.push(toLogicalLine(pieces, span))
  }
  return emitted
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
      candidates.push(
        ...candidatesForCell(buffer, cache, startY, currentY, span, startSlice, startRow)
      )
    }
  }
  return candidates.sort(
    (left, right) => right.rows.length - left.rows.length || right.text.length - left.text.length
  )
}
