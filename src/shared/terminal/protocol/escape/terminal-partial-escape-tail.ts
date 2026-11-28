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

// Bound unterminated OSC/DCS memory and snapshot size; beyond the cap, carry an inert prefix instead of the sequence.
export const MAX_PARTIAL_ESCAPE_TAIL_LENGTH = 4096

// Past the cap, a bare state prefix would let the continuation print or dispatch as a new command
// (#44623), so replay one that keeps xterm discarding until the sequence ends.
// A non-numeric OSC id aborts the command until BEL/ST.
const INERT_OSC_PREFIX = '\x1b]x;'
// A private marker after a parameter enters DCS_IGNORE until ST.
const INERT_DCS_PREFIX = '\x1bP0<'
const INERT_PREFIX_BY_STATE_PREFIX: Record<string, string> = {
  '\x1b]': INERT_OSC_PREFIX,
  '\x1bP': INERT_DCS_PREFIX,
  '\x1b[': '\x1b[0<' // the same marker enters CSI_IGNORE until the final byte
}
const INERT_STRING_PREFIXES = new Set([INERT_OSC_PREFIX, INERT_DCS_PREFIX])
// oxlint-disable-next-line no-control-regex -- C0/C1 bytes (including 8-bit ST 0x9c) that can end an open OSC/DCS string.
const STRING_END_BYTE = /[\x07\x18\x1a\x1b\u0080-\u009f]/

const C1_TO_7BIT_PREFIX: Record<number, string> = {
  0x90: '\x1bP',
  0x98: '\x1bX',
  0x9b: '\x1b[',
  0x9d: '\x1b]',
  0x9e: '\x1b^',
  0x9f: '\x1b_'
}

/** VT500 C1 control dispatch inside an open sequence; 0x9c (ST) and other C1 executes return to ground. */
function stateAfterC1Byte(code: number): ScanState {
  if (code === 0x9b) {
    return 'csi'
  }
  if (code === 0x9d) {
    return 'osc'
  }
  if (code === 0x90 || code === 0x98 || code === 0x9e || code === 0x9f) {
    return 'string'
  }
  return 'ground'
}

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
  return scanPartialEscapeTail(stream, false)
}

const STATE_PREFIX: Record<ScanState, string> = {
  ground: '',
  esc: '\x1b',
  escIntermediate: '\x1b ',
  csi: '\x1b[',
  osc: '\x1b]',
  oscEsc: '\x1b',
  string: '\x1bP',
  stringEsc: '\x1b'
}

/** Boundary-only fold; its constant-size state is NOT a replayable application tail. */
export function advanceTerminalEscapeBoundary(statePrefix: string, chunk: string): string {
  if (!statePrefix && !chunk.includes('\x1b')) {
    return ''
  }
  return scanPartialEscapeTail(statePrefix + chunk, true)
}

function scanPartialEscapeTail(stream: string, stateOnly: boolean): string {
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
    if (code >= 0x80 && code <= 0x9f) {
      // 8-bit C1 controls (including ST 0x9c) abort any open sequence; openers start a fresh one.
      state = stateAfterC1Byte(code)
      if (state !== 'ground') {
        start = i
      }
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
  if (stateOnly) {
    return STATE_PREFIX[state]
  }
  if (state === 'ground') {
    return ''
  }
  // Normalize C1 openers to 7-bit ESC prefixes so ground-state re-ingest preserves fold equivalence.
  const c1Prefix = C1_TO_7BIT_PREFIX[stream.charCodeAt(start)]
  return c1Prefix ? c1Prefix + stream.slice(start + 1) : stream.slice(start)
}

const STATE_BY_PREFIX: Record<string, ScanState> = {
  '\x1b': 'esc',
  '\x1b ': 'escIntermediate',
  '\x1b[': 'csi',
  '\x1b]': 'osc',
  '\x1bP': 'string'
}

/** Chars of chunk that finish the escape left open by advanceTerminalEscapeBoundary's statePrefix; a new ESC ends it unconsumed. -1 when it stays open. */
export function openEscapeContinuationLength(statePrefix: string, chunk: string): number {
  let state: ScanState = STATE_BY_PREFIX[statePrefix] ?? 'ground'
  for (let i = 0; i < chunk.length; i++) {
    if (state === 'ground') {
      return i
    }
    const code = chunk.charCodeAt(i)
    if (code === CAN || code === SUB) {
      return i + 1
    }
    if (code >= 0x80 && code <= 0x9f) {
      return stateAfterC1Byte(code) === 'ground' ? i + 1 : i
    }
    switch (state) {
      case 'esc':
        if (code === ESC) {
          return i
        }
        state = stateAfterEscByte(code)
        if (state === 'ground') {
          return i + 1
        }
        break
      case 'escIntermediate':
        if (code === ESC) {
          return i
        }
        if (code >= 0x30 && code <= 0x7e) {
          return i + 1
        }
        break
      case 'csi':
        if (code === ESC) {
          return i
        }
        if (code >= 0x40 && code <= 0x7e) {
          return i + 1
        }
        break
      case 'osc':
      case 'string':
        if (code === BEL && state === 'osc') {
          return i + 1
        }
        // Keep an ESC that may start a new sequence; if it was a split ST, its backslash later completes a no-op ST.
        if (code === ESC) {
          return chunk.charCodeAt(i + 1) === 0x5c ? i + 2 : i
        }
        break
      // Unreachable from a statePrefix (both map to 'esc'); an ESC inside a string either finishes ST or starts a kept sequence.
      case 'oscEsc':
      case 'stringEsc':
        return code === 0x5c ? i + 1 : i
    }
  }
  return state === 'ground' ? chunk.length : -1
}

/** Drop the part of chunk that continues the escape open in statePrefix; stillOpen carries it when the chunk ends first. */
export function skipOpenEscapeContinuation(
  statePrefix: string,
  chunk: string
): { rest: string; stillOpen: string } {
  const length = openEscapeContinuationLength(statePrefix, chunk)
  return length === -1
    ? { rest: '', stillOpen: advanceTerminalEscapeBoundary(statePrefix, chunk) }
    : { rest: chunk.slice(length), stillOpen: '' }
}

/** Advance the incremental tail, capped by capPartialEscapeTail. */
export function advancePartialEscapeTail(pendingTail: string, chunk: string): string {
  // Only ESC leaves ground, so no tail + no ESC avoids concatenation and the full chunk walk.
  if (pendingTail.length === 0 && !chunk.includes('\x1b')) {
    return ''
  }
  // An inert string stays inert until a byte that can end it, so large payloads skip the char walk.
  if (INERT_STRING_PREFIXES.has(pendingTail) && !STRING_END_BYTE.test(chunk)) {
    return pendingTail
  }
  return capPartialEscapeTail(extractPartialEscapeTail(pendingTail + chunk))
}

/** Past the cap, replace a tail with an inert prefix in the same parser state. */
export function capPartialEscapeTail(tail: string): string {
  if (tail.length <= MAX_PARTIAL_ESCAPE_TAIL_LENGTH) {
    return tail
  }
  const statePrefix = advanceTerminalEscapeBoundary('', tail)
  return INERT_PREFIX_BY_STATE_PREFIX[statePrefix] ?? statePrefix
}
