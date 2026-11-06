/** macOS resolves non-Latin Ctrl letters by physical position, but browser key retains the layout glyph and xterm Kitty encoding can send that instead (#13331). Recover the OS-equivalent control byte from code. */

/** Override only non-ASCII keys; ASCII remaps such as Dvorak remain authoritative. */
function hasNonAsciiLogicalKey(key: string): boolean {
  if (Array.from(key).length !== 1) {
    return false
  }
  return (key.codePointAt(0) ?? 0) > 0x7f
}

/** Resolve KeyA–Z except C; digits/punctuation remain ASCII. Ctrl+C belongs to interrupt policy, including selection-copy precedence and cleanup after SIGINT. */
function physicalLetterFromCode(code: string | undefined): string | null {
  if (!code || code.length !== 4 || !code.startsWith('Key')) {
    return null
  }
  const letter = code.charAt(3)
  if (letter === 'C') {
    return null
  }
  return letter >= 'A' && letter <= 'Z' ? letter : null
}

export type NonLatinControlChordEvent = {
  type: string
  key: string
  code?: string
  ctrlKey: boolean
  altKey: boolean
  metaKey: boolean
  shiftKey: boolean
}

/** Return plain Ctrl’s C0 byte; Shift stays with xterm’s distinct, already-correct Kitty encoding. */
export function resolveNonLatinControlChordInput(event: NonLatinControlChordEvent): string | null {
  if (event.type !== 'keydown') {
    return null
  }
  if (!event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) {
    return null
  }
  if (!hasNonAsciiLogicalKey(event.key)) {
    return null
  }
  const letter = physicalLetterFromCode(event.code)
  if (!letter) {
    return null
  }
  // 'A' -> 0x01 ... 'Z' -> 0x1a, the same arithmetic the OS control table applies.
  return String.fromCharCode(letter.charCodeAt(0) - 0x40)
}

/** The matching keyup, so a kitty release report for the swallowed press cannot leak. */
export function isNonLatinControlChordKeyup(
  event: NonLatinControlChordEvent,
  claimedCode: string | null
): boolean {
  if (event.type !== 'keyup' || !claimedCode) {
    return false
  }
  return event.code === claimedCode
}
