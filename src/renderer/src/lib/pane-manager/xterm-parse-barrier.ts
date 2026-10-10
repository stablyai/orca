// Why not write(''): xterm 6.1's resize() drains the queue through WriteBuffer.flushSync, whose
// `while (chunk = shift())` loop stops at an empty-string chunk and clears the rest of the queue,
// so the barrier's callback never fires and every write queued behind it is lost
// (xtermjs/xterm.js#6201). A zero-length Uint8Array parses as nothing but is a truthy chunk.
const PARSE_BARRIER = new Uint8Array(0)

type XtermWriter = { write(data: string | Uint8Array, callback?: () => void): void }

/** Runs `callback` once every write queued before it has parsed, without writing any bytes. */
export function writeXtermParseBarrier(terminal: XtermWriter, callback: () => void): void {
  terminal.write(PARSE_BARRIER, callback)
}
