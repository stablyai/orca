/** Half of macOS MAX_CANON: a typed line this long survived every canonical-mode write measured,
 *  and 1 KiB did not. */
export const TYPED_STARTUP_LINE_BUDGET_BYTES = 512

const encoder = new TextEncoder()

/** Any C0 byte or DEL: no quoter escapes them, so a line editor reads them as keys. */
export function hasControlByte(line: string): boolean {
  for (let i = 0; i < line.length; i += 1) {
    const code = line.charCodeAt(i)
    if (code < 0x20 || code === 0x7f) {
      return true
    }
  }
  return false
}

/** Whether a startup line can be typed into a shell as it is: every failure a long or multi-line
 *  typed line has (Enter mid-line, keys, MAX_CANON truncation) is a property of the line. */
export function typedStartupLineFits(line: string): boolean {
  return !hasControlByte(line) && encoder.encode(line).byteLength <= TYPED_STARTUP_LINE_BUDGET_BYTES
}
