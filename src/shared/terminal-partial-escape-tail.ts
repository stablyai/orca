// Snapshots serialize cells, not xterm’s pending parser bytes. Carry the incomplete escape after the screen so the next live chunk completes it instead of printing it (Bug E).

import { classifyTerminalEscapeIntroducer } from './terminal-escape-introducer'

// Mirror xterm’s VT500 states; C0 controls except ESC/CAN/SUB execute without aborting the sequence.
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

// Bound unterminated OSC/DCS memory and snapshot size; beyond the cap, abandon carry and lose partial-sequence fidelity.
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

/** Return the incomplete trailing escape (empty when clean), preserving extract(a + b) === extract(extract(a) + b) for incremental ingest. */
export function extractPartialEscapeTail(stream: string): string {
  let state: ScanState = 'ground'
  let start = 0
  for (let i = 0; i < stream.length; i++) {
    if (state === 'ground') {
      // Only ESC leaves ground; skip plain runs. Check dense-stream ESC directly to avoid indexOf setup per sequence.
      const escape = stream.charCodeAt(i) === ESC ? i : stream.indexOf('\x1b', i)
      if (escape === -1) {
        return ''
      }
      start = escape
      i = escape
      state = 'esc'
      continue
    }
    const code = stream.charCodeAt(i)
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
    // ESC/intermediate states need the same CAN/SUB abort as CSI/OSC/string or they retain bogus tails.
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

/** Advance the incremental tail; abandon it past the cap. */
export function advancePartialEscapeTail(pendingTail: string, chunk: string): string {
  // Only ESC leaves ground, so no tail + no ESC avoids concatenation and the full chunk walk.
  if (pendingTail.length === 0 && !chunk.includes('\x1b')) {
    return ''
  }
  const tail = extractPartialEscapeTail(pendingTail + chunk)
  return tail.length > MAX_PARTIAL_ESCAPE_TAIL_LENGTH ? '' : tail
}
