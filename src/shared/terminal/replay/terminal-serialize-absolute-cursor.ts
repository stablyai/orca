// SerializeAddon’s relative cursor math can land one column short after a full-width wrap-pending row. Restore source cursor coordinates with absolute CUP.
// Compose DECSC and mouse-encoding state omitted by the serializer for callers that require them.

import {
  buildMouseEncodingRestoreSequence,
  readTerminalMouseEncoding
} from '../protocol/input-modes/terminal-mouse-encoding'

type SerializeCursorTerminal = {
  cols: number
  rows: number
  buffer: { active: { cursorX: number; cursorY: number } }
}

type BufferSerializer<TOpts> = {
  serialize: (opts?: TOpts) => string
}

type ReprintCell = { getChars: () => string; getWidth: () => number }
type ReprintBuffer = {
  baseY: number
  cursorY: number
  getLine: (y: number) => { getCell: (x: number) => ReprintCell | undefined } | undefined
}
type ReprintTerminal = SerializeCursorTerminal & {
  modes?: { insertMode?: boolean }
  buffer: { active: ReprintBuffer; normal: { length: number } }
}
type RowSerializer = {
  serialize: (opts: {
    range: { start: number; end: number }
    excludeAltBuffer: true
    excludeModes: true
  }) => string
  // Vendored addon internal: serializes rows of any buffer (the public range API reads only normal).
  _serializeBufferByRange?: (
    terminal: unknown,
    buffer: unknown,
    range: { start: number; end: number },
    excludeFinalCursorPosition: boolean
  ) => string
}

/** VT100 DECSC saved-cursor register (0-based, viewport-relative row). */
export type SavedCursorRegister = { x: number; y: number; originMode: boolean }

// DECSC is private and per buffer; _core.buffer exposes the active register (including alt), matching what a later DECRC reads.
type TerminalWithSavedCursorCore = SerializeCursorTerminal & {
  modes?: { originMode?: boolean }
  _core?: {
    buffer?: {
      savedX?: number
      savedY?: number
      savedOriginMode?: boolean
      ybase?: number
      scrollTop?: number
      scrollBottom?: number
    }
  }
}

/** Reads the source terminal's active-buffer DECSC register, or null when it
 *  is unavailable or indistinguishable from the never-saved default. */
export function readSavedCursorRegister(
  terminal: SerializeCursorTerminal
): SavedCursorRegister | null {
  const core = (terminal as TerminalWithSavedCursorCore)._core?.buffer
  if (
    typeof core?.savedX !== 'number' ||
    typeof core.savedY !== 'number' ||
    typeof core.ybase !== 'number'
  ) {
    return null
  }
  // Mirror DECRC’s ybase-relative top clamp. CUP cannot recreate wrap-pending savedX == cols, so clamp that too.
  const y = Math.min(Math.max(core.savedY - core.ybase, 0), terminal.rows - 1)
  const x = Math.min(Math.max(core.savedX, 0), terminal.cols - 1)
  const originMode = core.savedOriginMode === true
  if (x === 0 && y === 0 && !originMode) {
    // Home is indistinguishable from never-saved; keep the fresh default register rather than overwrite its SGR/charset.
    return null
  }
  return { x, y, originMode }
}

export function serializeWithAbsoluteCursor<TOpts>(
  serializer: BufferSerializer<TOpts>,
  terminal: SerializeCursorTerminal,
  opts?: TOpts,
  savedCursor?: SavedCursorRegister | null
): string {
  const serialized = serializer.serialize(opts)
  // Empty means nothing to restore to callers; a bare CUP would persist every idle pane.
  if (serialized.length === 0) {
    return serialized
  }
  // Why: the addon re-arms mouse tracking but not its encoding; restoring one without the other makes X10 reports.
  const mouseEncodingRestore = serializesModes(opts)
    ? buildMouseEncodingRestoreSequence(readTerminalMouseEncoding(terminal))
    : ''
  return `${serialized}${mouseEncodingRestore}${buildAbsoluteCursorRestoreSequence(terminal, savedCursor, { serializer })}`
}

/** Live pen SGR and OSC 8 link, without cells. */
export function serializeCurrentPenState(serializer: unknown, terminal: unknown): string {
  // Our vendored addon’s undocumented out-of-range row behavior emits only the live pen state.
  const emptyRow = (terminal as ReprintTerminal).buffer.normal.length
  return (serializer as RowSerializer).serialize({
    range: { start: emptyRow, end: emptyRow },
    excludeAltBuffer: true,
    excludeModes: true
  })
}

// A cursor move cannot set pending wrap; reprinting the row so it ends on the edge cell can (STA-16354).
function buildPendingWrapRestore(
  serializer: unknown,
  terminal: SerializeCursorTerminal,
  cupCursorY: number
): string | null {
  const source = terminal as ReprintTerminal
  const serializeRows = (serializer as RowSerializer)._serializeBufferByRange
  if (typeof serializeRows !== 'function') {
    return null
  }
  const buffer = source.buffer.active
  const row = buffer.baseY + buffer.cursorY
  const edge = buffer.getLine(row)?.getCell(terminal.cols - 1)
  // A blank edge serializes to nothing, so the reprint would stop short of the wrap.
  if (!edge || (edge.getChars() === '' && edge.getWidth() !== 0)) {
    return null
  }
  const rowAnsi = serializeRows.call(serializer, terminal, buffer, { start: row, end: row }, true)
  // Insert mode would shift the old cells into the reprint's skipped blanks.
  const insertMode = source.modes?.insertMode === true
  return `${insertMode ? '\x1b[4l' : ''}\x1b[${cupCursorY + 1};1H\x1b[0m${rowAnsi}${insertMode ? '\x1b[4h' : ''}\x1b[0m${serializeCurrentPenState(serializer, terminal)}`
}

function serializesModes(opts: unknown): boolean {
  return !(
    typeof opts === 'object' &&
    opts !== null &&
    'excludeModes' in opts &&
    opts.excludeModes === true
  )
}

/** Cursor state appended after serialized modes; safe to replay without the frame body. */
export function buildAbsoluteCursorRestoreSequence(
  terminal: SerializeCursorTerminal,
  savedCursor?: SavedCursorRegister | null,
  options: { restoreModesWithoutCursor?: boolean; serializer?: unknown } = {}
): string {
  const { cursorX, cursorY } = terminal.buffer.active
  const terminalWithCore = terminal as TerminalWithSavedCursorCore
  const buffer = terminalWithCore._core?.buffer
  const scrollTop = buffer?.scrollTop ?? 0
  const scrollBottom = buffer?.scrollBottom ?? terminal.rows - 1
  const originMode = terminalWithCore.modes?.originMode === true
  const cupCursorY = cursorY - (originMode ? scrollTop : 0)
  const cursorRowInView = cupCursorY >= 0 && cupCursorY < terminal.rows
  // Trailing DECSTBM/DECOM home the cursor, so a wrap-pending cursor (cursorX == cols) needs its row reprinted.
  const pendingWrapRestore =
    cursorX === terminal.cols && cursorRowInView && options.serializer !== undefined
      ? buildPendingWrapRestore(options.serializer, terminal, cupCursorY)
      : null
  // Never emit a CUP that clamps; a clamped wrap-pending cursor would overwrite the edge cell.
  const canRestoreCurrentCursor =
    pendingWrapRestore !== null || (cursorX >= 0 && cursorX < terminal.cols && cursorRowInView)
  if (!canRestoreCurrentCursor && options.restoreModesWithoutCursor !== true) {
    return ''
  }
  // Carry saved position or a later DECRC can restore home over live cells (Bug D). Save against a full region so older margins/origin cannot hide the row.
  // Position-only tradeoff: synthetic DECSC saves the serializer’s final pen, not the source saved SGR/charset.
  const savedRestore = savedCursor
    ? `\x1b[r\x1b[?6${savedCursor.originMode ? 'h' : 'l'}\x1b[${savedCursor.y + 1};${savedCursor.x + 1}H\x1b7`
    : ''
  const mustRestoreModes = savedCursor != null || options.restoreModesWithoutCursor === true
  const scrollRegionRestore =
    mustRestoreModes && (scrollTop !== 0 || scrollBottom !== terminal.rows - 1)
      ? `\x1b[${scrollTop + 1};${scrollBottom + 1}r`
      : ''
  const originModeRestore = mustRestoreModes ? `\x1b[?6${originMode ? 'h' : 'l'}` : ''
  // DECOM makes CUP margin-relative; scrollback length does not change viewport coordinates.
  const currentCursorRestore =
    pendingWrapRestore ?? (canRestoreCurrentCursor ? `\x1b[${cupCursorY + 1};${cursorX + 1}H` : '')
  return `${savedRestore}${scrollRegionRestore}${originModeRestore}${currentCursorRestore}`
}
