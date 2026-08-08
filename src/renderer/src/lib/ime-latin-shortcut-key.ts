/**
 * Does this keyboard event carry the Latin letter a Mod+<letter> shortcut is looking for?
 *
 * Why: with a CJK input source active, macOS and Windows report the PHYSICAL key through
 * `code` but rewrite `key` to the layout's character — Korean 2-Set turns Cmd+C into
 * `{ key: "ㅊ", code: "KeyC", metaKey: true }`. A `key.toLowerCase() === 'c'` match misses,
 * the shortcut is not recognised, and xterm encodes the chord as PTY input instead
 * (issue #12164's sibling #13033: the viewport jumps to the bottom because user input
 * scrolls the terminal). This is the same key-vs-code confusion that owned #12171, where a
 * `Shift+T` typing ㅆ was misread as Enter for want of a `code` guard.
 *
 * `code` is authoritative when present, so it is checked first. `key` remains the fallback
 * for events that carry no `code` — Chromium omits it on synthetic and some keypress events.
 */
export type LatinShortcutKeyEvent = {
  code?: string
  key: string
  keyCode?: number
}

/** `KeyA`-style code for a single Latin letter, e.g. `c` -> `KeyC`. */
function physicalCodeForLetter(letter: string): string {
  return `Key${letter.toUpperCase()}`
}

/**
 * True when `event` is the physical key for `letter`, whatever the IME rewrote `key` to.
 * `letter` must be a single a-z character.
 */
export function isLatinShortcutKey(event: LatinShortcutKeyEvent, letter: string): boolean {
  const code = event.code?.trim()
  if (code) {
    return code === physicalCodeForLetter(letter)
  }
  // Why: no `code` to trust, so fall back to the logical key, then to the legacy
  // keyCode — which stays the US-layout value even when `key` has been rewritten.
  if (event.key.toLowerCase() === letter) {
    return true
  }
  return event.keyCode === letter.toUpperCase().charCodeAt(0)
}
