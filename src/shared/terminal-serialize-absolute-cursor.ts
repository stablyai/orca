// Why this module exists: @xterm/addon-serialize restores the cursor with
// RELATIVE moves (CUD/CUB) computed from where it assumes replay leaves the
// cursor. When the final content row is filled exactly to the right margin,
// replay leaves the fresh terminal wrap-pending (internal x == cols), so the
// relative math lands one column short of the real cursor. Every Orca buffer
// snapshot that will be replayed into another terminal must therefore end
// with an absolute CUP derived from the SOURCE terminal's authoritative
// cursor position. Snapshot producers that also need the VT100 DECSC
// saved-cursor register carried across the restore compose it here too.

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

// xterm keeps the DECSC register on each Buffer (savedY is absolute:
// ybase-included). It is not exposed through the public API, so snapshot
// producers read the core buffer directly — `_core.buffer` is the ACTIVE
// buffer, so an alt-screen TUI yields the alternate screen's own register,
// matching the one a post-restore DECRC would consult.
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
  // savedY is absolute; DECRC restores it relative to the ybase current at
  // restore time, clamping at the top — mirror that clamp here. savedX can be
  // cols (DECSC during wrap-pending); CUP cannot re-create pending, so clamp.
  const y = Math.min(Math.max(core.savedY - core.ybase, 0), terminal.rows - 1)
  const x = Math.min(Math.max(core.savedX, 0), terminal.cols - 1)
  const originMode = core.savedOriginMode === true
  if (x === 0 && y === 0 && !originMode) {
    // Home is xterm's never-saved default: a fresh restore terminal already
    // sends DECRC to home, and skipping the injection avoids overwriting the
    // fresh terminal's default saved SGR/charset when nothing was ever saved.
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
  // Why skip empty snapshots: several callers treat '' as "nothing to
  // restore" (e.g. shutdown layout capture drops empty buffers); a bare CUP
  // would turn every idle pane into a persisted snapshot.
  if (serialized.length === 0) {
    return serialized
  }
  return `${serialized}${buildAbsoluteCursorRestoreSequence(terminal, savedCursor)}`
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
  // Why skip wrap-pending sources (cursorX == cols): plain replay already
  // reproduces that state exactly, while CUP would clamp to the last column
  // and clear the pending-wrap flag, changing how the next byte renders.
  // The remaining bounds checks are defensive: never emit a clamping CUP.
  const canRestoreCurrentCursor =
    cursorX >= 0 && cursorX < terminal.cols && cupCursorY >= 0 && cupCursorY < terminal.rows
  if (!canRestoreCurrentCursor && options.restoreModesWithoutCursor !== true) {
    return ''
  }
  // Why the DECSC injection: the serialized screen cannot carry the VT100
  // saved-cursor register, so a hidden DECSC followed by a post-reveal DECRC
  // restored to home and clobbered live cells (Bug D in
  // notes/garble-fuzz-divergences.md). Re-establish the register by saving at
  // the source's saved position, then CUP back to the real cursor. Saved SGR/
  // charset are not carried — the synthetic ESC 7 saves the serializer's
  // final pen, a deliberate position-only fidelity trade.
  // Install the saved register against a full region so its absolute row is
  // representable even when it predates the current DECSTBM/DECOM state.
  const savedRestore = savedCursor
    ? `\x1b[r\x1b[?6${savedCursor.originMode ? 'h' : 'l'}\x1b[${savedCursor.y + 1};${savedCursor.x + 1}H\x1b7`
    : ''
  const mustRestoreModes = savedCursor != null || options.restoreModesWithoutCursor === true
  const scrollRegionRestore =
    mustRestoreModes && (scrollTop !== 0 || scrollBottom !== terminal.rows - 1)
      ? `\x1b[${scrollTop + 1};${scrollBottom + 1}r`
      : ''
  const originModeRestore = mustRestoreModes ? `\x1b[?6${originMode ? 'h' : 'l'}` : ''
  // CUP rows become margin-relative under DECOM; ordinary snapshots keep the
  // zero offset because scrollback length does not shift viewport coordinates.
  const currentCursorRestore = canRestoreCurrentCursor
    ? `\x1b[${cupCursorY + 1};${cursorX + 1}H`
    : ''
  return `${savedRestore}${scrollRegionRestore}${originModeRestore}${currentCursorRestore}`
}
