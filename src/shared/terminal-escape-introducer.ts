// The byte after ESC decides which VT500 sequence just opened. Two scanners need that
// decision -- the partial-tail state machine (`terminal-partial-escape-tail.ts`) and the
// preview normalizer's per-sequence parser (`terminal-ansi-normalization.ts`) -- and they
// must agree on the DCS/SOS/PM/APC set, so the table lives here rather than in each.

export type TerminalEscapeIntroducer =
  | 'csi' // [
  | 'osc' // ]
  | 'string' // P / X / ^ / _ open DCS / SOS / PM / APC -- ST-terminated
  | 'intermediate' // 0x20-0x2f, more bytes to come before the final
  | 'execute' // C0 executes / DEL is ignored; the ESC is still pending
  | 'final' // completes a two-byte sequence (ESC 7, ESC 8, ESC c, ...)

/** Classifies the code unit after ESC. `NaN` (ESC at end of input) reads as `final`. */
export function classifyTerminalEscapeIntroducer(code: number): TerminalEscapeIntroducer {
  if (code === 0x5b) {
    return 'csi'
  }
  if (code === 0x5d) {
    return 'osc'
  }
  if (code === 0x50 || code === 0x58 || code === 0x5e || code === 0x5f) {
    return 'string'
  }
  if (code >= 0x20 && code <= 0x2f) {
    return 'intermediate'
  }
  if (code < 0x20 || code === 0x7f) {
    return 'execute'
  }
  return 'final'
}
