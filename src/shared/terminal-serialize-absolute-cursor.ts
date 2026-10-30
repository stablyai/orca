// SerializeAddon’s relative cursor math can land one column short after a full-width wrap-pending row. Restore source cursor coordinates with absolute CUP.
// Compose DECSC and mouse-encoding state omitted by the serializer for callers that require them.

import {
  buildMouseEncodingRestoreSequence,
  readTerminalMouseEncoding
} from './terminal-mouse-encoding'

type SerializeCursorTerminal = {
  cols: number
  rows: number
  buffer: { active: { cursorX: number; cursorY: number } }
}

type BufferSerializer<TOpts> = {
  serialize: (opts?: TOpts) => string
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
  return `${serialized}${mouseEncodingRestore}${buildAbsoluteCursorRestoreSequence(terminal, savedCursor)}`
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
  options: { restoreModesWithoutCursor?: boolean } = {}
): string {
  const { cursorX, cursorY } = terminal.buffer.active
  const terminalWithCore = terminal as TerminalWithSavedCursorCore
  const buffer = terminalWithCore._core?.buffer
  const scrollTop = buffer?.scrollTop ?? 0
  const scrollBottom = buffer?.scrollBottom ?? terminal.rows - 1
  const originMode = terminalWithCore.modes?.originMode === true
  const cupCursorY = cursorY - (originMode ? scrollTop : 0)
  // Replay preserves wrap-pending cursorX == cols; CUP would clamp and change the next byte. Never emit a CUP that clamps.
  const canRestoreCurrentCursor =
    cursorX >= 0 && cursorX < terminal.cols && cupCursorY >= 0 && cupCursorY < terminal.rows
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
  const currentCursorRestore = canRestoreCurrentCursor
    ? `\x1b[${cupCursorY + 1};${cursorX + 1}H`
    : ''
  return `${savedRestore}${scrollRegionRestore}${originModeRestore}${currentCursorRestore}`
}
