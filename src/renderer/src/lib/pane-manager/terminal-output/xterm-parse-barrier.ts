// Empty-string barriers are lost by xterm 6.1 flushSync’s truthiness loop, which also drops following writes (#6201). Use a truthy zero-length Uint8Array that parses no bytes.
const PARSE_BARRIER = new Uint8Array(0)

type XtermWriter = { write(data: string | Uint8Array, callback?: () => void): void }

/** Runs `callback` once every write queued before it has parsed, without writing any bytes. */
export function writeXtermParseBarrier(terminal: XtermWriter, callback: () => void): void {
  terminal.write(PARSE_BARRIER, callback)
}
