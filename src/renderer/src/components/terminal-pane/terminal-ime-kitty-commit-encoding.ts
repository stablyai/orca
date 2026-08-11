// Reuses xterm's own kitty encoder rather than hand-rolling CSI-u. It lives in
// the package's `src/` tree and is absent from the public typings, so this is a
// deep import into a pinned dependency — acceptable here because the version is
// already pinned by a patch that would fail to apply across a bump.
import { KittyKeyboard } from '@xterm/xterm/src/common/input/KittyKeyboard'

/**
 * `report_all_keys_as_escape_codes`. Bit 3 is the only flag that changes what a
 * plain printable key should put on the wire; 1/2/4/16 leave it as text.
 */
const KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES = 0b1000

/**
 * `KittyKeyboardEventType.PRESS` / `.REPEAT`. Inlined because the upstream enum is a
 * `const enum`, which does not survive an import across module boundaries.
 */
const KITTY_EVENT_TYPE_PRESS = 1
const KITTY_EVENT_TYPE_REPEAT = 2

const kittyKeyboardEncoder = new KittyKeyboard()

/** The physical keydown that produced a commit, captured before the input event. */
export type ImeCommitKeyPress = {
  key: string
  code?: string
  shiftKey: boolean
  /** An auto-repeat keydown; the protocol distinguishes it from a fresh press. */
  repeat?: boolean
}

/**
 * A pane that negotiated bit 3 asked for every printable key as a CSI-u report,
 * so writing IME-committed text raw hands it the legacy byte stream it declined.
 * Re-encode the press that produced the commit instead.
 *
 * The gate is bit 3 ALONE. "Kitty is active" and `flags !== 0` are both wrong:
 * a pane negotiating only disambiguation or event types still expects printable
 * keys as text, and encoding there would drop every substituted character.
 *
 * Returns null when the commit should be written raw, which is every case except
 * bit 3.
 *
 * Known limit: the report carries the *physical* key's codepoint, not the
 * committed glyph — bit 3 is the app declaring it does not want text, and bit 4
 * (`report_associated_text`) is how it asks for text back. xterm's encoder
 * derives that text field from the same `key` it derives the keycode from, so
 * carrying the committed glyph under bit 4 needs an encoder change, not a flag.
 */
export function encodeImeCommitAsKittyReport(
  press: ImeCommitKeyPress | null,
  kittyKeyboardFlags: number
): string | null {
  if ((kittyKeyboardFlags & KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES) === 0 || !press) {
    return null
  }
  // Why: the forwarder only claims presses with no control chord, so the
  // modifier fields are known-false rather than read from a live event.
  const encoded = kittyKeyboardEncoder.evaluate(
    {
      type: 'keydown',
      key: press.key,
      code: press.code ?? '',
      keyCode: 0,
      shiftKey: press.shiftKey,
      altKey: false,
      ctrlKey: false,
      metaKey: false
    },
    kittyKeyboardFlags,
    // Why: a held key emits repeated keydowns, and the protocol reports those as REPEAT.
    // Defaulting them all to PRESS would make one held key look like N separate strikes to
    // an app that counts presses or filters repeats.
    press.repeat === true ? KITTY_EVENT_TYPE_REPEAT : KITTY_EVENT_TYPE_PRESS
  )
  return encoded.key ?? null
}
