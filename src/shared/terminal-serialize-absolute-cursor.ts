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
export type SavedCursorRegister = { x: number; y: number }

// xterm keeps the DECSC register on each Buffer (savedY is absolute:
// ybase-included). It is not exposed through the public API, so snapshot
// producers read the core buffer directly — `_core.buffer` is the ACTIVE
// buffer, so an alt-screen TUI yields the alternate screen's own register,
// matching the one a post-restore DECRC would consult.
type TerminalWithSavedCursorCore = SerializeCursorTerminal & {
  _core?: { buffer?: { savedX?: number; savedY?: number; ybase?: number } }
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
  if (x === 0 && y === 0) {
    // Home is xterm's never-saved default: a fresh restore terminal already
    // sends DECRC to home, and skipping the injection avoids overwriting the
    // fresh terminal's default saved SGR/charset when nothing was ever saved.
    return null
  }
  return { x, y }
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
  const { cursorX, cursorY } = terminal.buffer.active
  // Why skip wrap-pending sources (cursorX == cols): plain replay already
  // reproduces that state exactly, while CUP would clamp to the last column
  // and clear the pending-wrap flag, changing how the next byte renders.
  // The remaining bounds checks are defensive: never emit a clamping CUP.
  // The saved-cursor injection is skipped with it — it moves the cursor, so
  // it may only ride along when the absolute CUP restores the position after.
  if (cursorX < 0 || cursorX >= terminal.cols || cursorY < 0 || cursorY >= terminal.rows) {
    return serialized
  }
  // Why the DECSC injection: the serialized screen cannot carry the VT100
  // saved-cursor register, so a hidden DECSC followed by a post-reveal DECRC
  // restored to home and clobbered live cells (Bug D in
  // notes/garble-fuzz-divergences.md). Re-establish the register by saving at
  // the source's saved position, then CUP back to the real cursor. Saved SGR/
  // charset are not carried — the synthetic ESC 7 saves the serializer's
  // final pen, a deliberate position-only fidelity trade.
  const savedRestore = savedCursor ? `\x1b[${savedCursor.y + 1};${savedCursor.x + 1}H\x1b7` : ''
  // cursorY is viewport-relative (0 at the buffer's base row), which is the
  // same coordinate space CUP addresses after replay; scrollback length
  // differences between source and destination do not shift it.
  return `${serialized}${savedRestore}\x1b[${cursorY + 1};${cursorX + 1}H`
}
