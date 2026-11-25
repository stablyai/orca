// Share VT500 dispatch between tail tracking and preview normalization so their DCS/SOS/PM/APC classifications agree.

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
