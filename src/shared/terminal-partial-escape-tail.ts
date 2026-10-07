// Why this module exists: a PTY read can end mid-escape-sequence. The bytes
// already handed to xterm sit inside its parser state machine, not the screen
// buffer, so a serialized snapshot cannot carry them — and the next chunk's
// continuation bytes then render as literal text after a snapshot restore
// (Bug E in notes/garble-fuzz-divergences.md). Tracking the unparsed trailing
// partial sequence at the ingest boundary lets snapshot producers append it
// after the serialized screen so the continuation completes exactly as live.

import { classifyTerminalEscapeIntroducer } from './terminal-escape-introducer'

// Mirrors the VT500 parser states that can span a chunk boundary. C0 controls
// (except ESC/CAN/SUB) execute mid-sequence without aborting it, matching
// xterm's state machine.
type ScanState =
  | 'ground'
  | 'esc'
  | 'escIntermediate'
  | 'csi'
  | 'osc'
  | 'oscEsc'
  | 'string'
  | 'stringEsc'

const ESC = 0x1b
const CAN = 0x18
const SUB = 0x1a
const BEL = 0x07
// oxlint-disable-next-line no-control-regex -- VT sequences start with ESC or C1 controls.
const HAS_SEQUENCE_INTRODUCER = /[\x1b\x90\x98\x9b\x9d-\x9f]/

// Why a cap: OSC/DCS payloads are unbounded and an unterminated one would
// grow the tracked tail (and every snapshot) without limit. Real payloads
// (titles, cwd, hyperlinks) are far below this; beyond it we stop tracking
// and degrade to the pre-fix behavior for that pathological stream.
export const MAX_PARTIAL_ESCAPE_TAIL_LENGTH = 4096

/** ESC-state transition shared by the fresh-ESC and abort-reprocess paths. */
function stateAfterEscByte(code: number): ScanState {
  switch (classifyTerminalEscapeIntroducer(code)) {
    case 'csi':
      return 'csi'
    case 'osc':
      return 'osc'
    case 'string':
      return 'string'
    case 'intermediate':
      return 'escIntermediate'
    case 'execute':
      return 'esc' // the ESC is still pending; a further ESC arrives via the callers
    case 'final':
      return 'ground'
  }
}

/** Returns the trailing incomplete escape sequence of `stream` ('' when the
 *  stream ends parser-clean). Fold-safe across chunk boundaries:
 *  extract(a + b) === extract(extract(a) + b), which is how ingest-time
 *  trackers advance without keeping the whole stream. */
export function extractPartialEscapeTail(stream: string): string {
  // oxlint-disable-next-line no-control-regex -- Skip text until an ESC or C1 sequence starts.
  const introducers = /[\x1b\x90\x98\x9b\x9d-\x9f]/g
  let state: ScanState = 'ground'
  let start = 0
  for (let i = 0; i < stream.length; i++) {
    if (state === 'ground') {
      // Skip ordinary output while retaining both ESC and C1 introducers.
      introducers.lastIndex = i
      const escape = stream.charCodeAt(i) === ESC ? i : (introducers.exec(stream)?.index ?? -1)
      if (escape === -1) {
        return ''
      }
      start = escape
      i = escape
      const code = stream.charCodeAt(escape)
      state = code === ESC ? 'esc' : code === 0x9b ? 'csi' : code === 0x9d ? 'osc' : 'string'
      continue
    }
    const code = stream.charCodeAt(i)
    if (code >= 0x80 && code <= 0x9f) {
      start = i
      state =
        code === 0x9b
          ? 'csi'
          : code === 0x9d
            ? 'osc'
            : code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f
              ? 'string'
              : 'ground'
      continue
    }
    if (
      code === ESC &&
      state !== 'osc' &&
      state !== 'string' &&
      state !== 'oscEsc' &&
      state !== 'stringEsc'
    ) {
      // ESC aborts a pending ESC/CSI sequence and starts a new one.
      start = i
      state = 'esc'
      continue
    }
    // CAN/SUB abort an in-progress escape sequence back to ground in every
    // non-string state (xterm's VT500 parser). The csi/osc/string cases handle
    // this inline below; esc/escIntermediate must too, or `ESC CAN` and
    // `ESC <intermediate> CAN` leave a bogus tail instead of dropping to ground.
    if ((code === CAN || code === SUB) && (state === 'esc' || state === 'escIntermediate')) {
      state = 'ground'
      continue
    }
    switch (state) {
      case 'esc':
        state = stateAfterEscByte(code)
        break
      case 'escIntermediate':
        if (code >= 0x30 && code <= 0x7e) {
          state = 'ground'
        }
        // 0x20–0x2f stays; other C0 executes and stays (CAN/SUB handled above).
        break
      case 'csi':
        if (code === CAN || code === SUB) {
          state = 'ground'
        } else if (code >= 0x40 && code <= 0x7e) {
          state = 'ground' // final byte completes the CSI
        }
        // params/intermediates (0x20–0x3f), C0, DEL stay in-sequence.
        break
      case 'osc':
        if (code === BEL || code === CAN || code === SUB) {
          state = 'ground'
        } else if (code === ESC) {
          state = 'oscEsc'
        }
        break
      case 'oscEsc':
        if (code === 0x5c) {
          state = 'ground' // ESC \ = ST terminates the OSC
        } else {
          // The ESC aborted the OSC and opened a new sequence at i-1 — except a
          // second ESC starts its own sequence at i, and CAN/SUB abort to ground.
          start = code === ESC ? i : i - 1
          state =
            code === ESC ? 'esc' : code === CAN || code === SUB ? 'ground' : stateAfterEscByte(code)
        }
        break
      case 'string':
        if (code === CAN || code === SUB) {
          state = 'ground'
        } else if (code === ESC) {
          state = 'stringEsc'
        }
        break
      case 'stringEsc':
        if (code === 0x5c) {
          state = 'ground'
        } else {
          start = code === ESC ? i : i - 1
          state =
            code === ESC ? 'esc' : code === CAN || code === SUB ? 'ground' : stateAfterEscByte(code)
        }
        break
    }
  }
  // ESC already ends a string in xterm; replay only its pending escape state.
  if (state === 'oscEsc' || state === 'stringEsc') {
    return '\x1b'
  }
  return state === 'ground' ? '' : stream.slice(start)
}

/** Ingest-time fold: advance the tracked tail with one more chunk. Returns ''
 *  (tracking abandoned) when the tail exceeds the cap — see the cap comment. */
export function advancePartialEscapeTail(pendingTail: string, chunk: string): string {
  // Skip concatenation and scanning for ordinary output, including single-character echo.
  if (pendingTail.length === 0 && !HAS_SEQUENCE_INTRODUCER.test(chunk)) {
    return ''
  }
  const tail = extractPartialEscapeTail(pendingTail + chunk)
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail
}
