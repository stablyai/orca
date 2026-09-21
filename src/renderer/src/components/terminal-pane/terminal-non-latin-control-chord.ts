/**
 * Control chords on a non-Latin keyboard layout.
 *
 * macOS resolves these positionally: measured with `UCKeyTranslate`, physical C/A/U under
 * Control produce U+0003/U+0001/U+0015 on 2SetHangul, Russian and Greek exactly as they do
 * on ABC, even though the same keys unmodified produce `ㅊ`/`с`/`ψ`. A native terminal gets
 * this for free by passing the OS-provided characters through.
 *
 * The browser does not expose that translation. `KeyboardEvent.key` carries the layout's
 * glyph, so anything matching on `key` sees `ㅁ` for Ctrl+A and cannot recognise the chord.
 * xterm's legacy encoder sidesteps it by reading `keyCode` (65-90), which Chromium reports
 * from the physical key — but its kitty encoder derives the key number from `key`, and only
 * consults `code` when Shift or Option is held. Ctrl is not in that gate, so a pane with the
 * kitty protocol negotiated reports CSI-u for U+3141 instead of `a` and the chord does
 * nothing (#13331). Ctrl+C escaped this only because it has a hand-written ETX bypass.
 *
 * Recovering the byte from `code` reproduces what the OS itself would have produced.
 */

/** Only a non-ASCII `key` is ambiguous. A Latin layout that moves letters (Dvorak) reports a
 *  real ASCII letter, and that letter is authoritative — never override it. */
function hasNonAsciiLogicalKey(key: string): boolean {
  if (Array.from(key).length !== 1) {
    return false
  }
  return (key.codePointAt(0) ?? 0) > 0x7f
}

/**
 * `KeyA`-`KeyZ` except `KeyC`. Digits and punctuation stay ASCII in `key` on these layouts,
 * so they reach xterm intact and are not this module's to touch.
 *
 * `KeyC` is excluded because Ctrl+C is not a plain control chord: off macOS it must yield to
 * a selection so the copy binding wins, and it resets the pane's kitty flags because a CLI
 * can die on SIGINT before restoring them. The interrupt policy owns all of that and runs
 * first; claiming C here would send ETX in the one case that policy deliberately declines.
 */
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

/**
 * The C0 byte a plain Ctrl chord should send, or null when this event is not one.
 *
 * Shift is excluded deliberately: Ctrl+Shift chords have their own encoding, and rewriting
 * them here would change what a kitty pane reports for a key it already handles correctly.
 */
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
