export const TERMINAL_FOCUS_IN_SEQUENCE = '\u001b[I'
export const TERMINAL_FOCUS_OUT_SEQUENCE = '\u001b[O'

export function isTerminalFocusReport(data: string): boolean {
  if (!data) {
    return false
  }
  for (let offset = 0; offset < data.length; offset += TERMINAL_FOCUS_IN_SEQUENCE.length) {
    const report = data.slice(offset, offset + TERMINAL_FOCUS_IN_SEQUENCE.length)
    if (report !== TERMINAL_FOCUS_IN_SEQUENCE && report !== TERMINAL_FOCUS_OUT_SEQUENCE) {
      return false
    }
  }
  return true
}
