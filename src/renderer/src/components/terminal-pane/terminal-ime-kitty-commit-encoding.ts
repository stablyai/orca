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

/** `report_event_types`. The only flag that makes a printable press owe a release. */
const KITTY_REPORT_EVENT_TYPES = 0b0010

/**
 * `KittyKeyboardEventType.PRESS` / `.REPEAT` / `.RELEASE`. Inlined because the
 * upstream enum is a `const enum`, which does not survive an import across
 * module boundaries.
 */
const KITTY_EVENT_TYPE_PRESS = 1
const KITTY_EVENT_TYPE_REPEAT = 2
const KITTY_EVENT_TYPE_RELEASE = 3

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
 * The matching physical release, read from the actual `keyup`.
 *
 * Why not reuse the press's fields: macOS lets Shift come up first, and the
 * browser then reports the printable keyup with the UNSHIFTED `key` and
 * `shiftKey: false`. Encoding that release from the press's shifted fields
 * would report a modifier the app no longer holds.
 */
export type ImeReleaseKeyEvent = {
  key: string
  code?: string
  shiftKey: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
}

/**
 * Opaque proof that a delivered press/repeat owes a release report, carrying
 * the flags read at commit time. Only `encodeImeReleaseForKitty` interprets it:
 * the forwarder must never re-test event-type bits or rebuild CSI-u itself.
 */
export type ImeCommitReleaseObligation = { readonly flags: number }

export type ImeCommitKittyEncoding = {
  /** CSI-u press/repeat report, or null when the commit goes out as raw text. */
  report: string | null
  /** Non-null when the commit-time flags requested press/repeat/release events. */
  release: ImeCommitReleaseObligation | null
}

function evaluateKittyReport(
  press: { key: string; code?: string; shiftKey: boolean },
  modifiers: { ctrlKey?: boolean; altKey?: boolean; metaKey?: boolean },
  kittyKeyboardFlags: number,
  eventType: number
): string | null {
  const encoded = kittyKeyboardEncoder.evaluate(
    {
      type: eventType === KITTY_EVENT_TYPE_RELEASE ? 'keyup' : 'keydown',
      key: press.key,
      code: press.code ?? '',
      keyCode: 0,
      shiftKey: press.shiftKey,
      altKey: modifiers.altKey === true,
      ctrlKey: modifiers.ctrlKey === true,
      metaKey: modifiers.metaKey === true
    },
    kittyKeyboardFlags,
    eventType
  )
  return encoded.key ?? null
}

/**
 * A pane that negotiated bit 3 asked for every printable key as a CSI-u report,
 * so writing IME-committed text raw hands it the legacy byte stream it declined.
 * Re-encode the press that produced the commit instead.
 *
 * The gate is bit 3 ALONE for the press. "Kitty is active" and `flags !== 0` are
 * both wrong: a pane negotiating only disambiguation or event types still
 * expects printable keys as text, and encoding there would drop every
 * substituted character. Bit 1 (`report_event_types`) is independent — it makes
 * even a raw-text commit owe exactly one release report.
 *
 * Known limit: the report carries the *physical* key's codepoint, not the
 * committed glyph — bit 3 is the app declaring it does not want text, and bit 4
 * (`report_associated_text`) is how it asks for text back. xterm's encoder
 * derives that text field from the same `key` it derives the keycode from, so
 * carrying the committed glyph under bit 4 needs an encoder change, not a flag.
 */
export function encodeImeCommitForKitty(
  press: ImeCommitKeyPress | null,
  kittyKeyboardFlags: number
): ImeCommitKittyEncoding {
  if (!press) {
    return { report: null, release: null }
  }
  const report =
    (kittyKeyboardFlags & KITTY_REPORT_ALL_KEYS_AS_ESCAPE_CODES) === 0
      ? null
      : evaluateKittyReport(
          press,
          // Why: the forwarder only claims presses with no control chord, so the
          // modifier fields are known-false rather than read from a live event.
          {},
          kittyKeyboardFlags,
          // Why: a held key emits repeated keydowns, and the protocol reports those as REPEAT.
          // Defaulting them all to PRESS would make one held key look like N separate strikes to
          // an app that counts presses or filters repeats.
          press.repeat === true ? KITTY_EVENT_TYPE_REPEAT : KITTY_EVENT_TYPE_PRESS
        )
  return {
    report,
    release:
      (kittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) === 0 ? null : { flags: kittyKeyboardFlags }
  }
}

/**
 * Resolve a press's release obligation against the physical `keyup` that
 * actually settled it. Returns null when no release report is owed anymore.
 */
export function encodeImeReleaseForKitty(
  obligation: ImeCommitReleaseObligation,
  release: ImeReleaseKeyEvent,
  context: {
    /** The claimed press's identity, for keyups whose `key` an input source rewrote. */
    press?: { key: string; code?: string }
    /** The pane's flags at RELEASE time, deciding whether a release is still wanted. */
    currentKittyKeyboardFlags: number
  }
): string | null {
  // Why the current-flags gate: the app can pop kitty mode between commit and
  // keyup (a TUI quitting on the pressed key). xterm suppresses releases the
  // moment `report_event_types` is gone — match it so the successor process
  // never receives CSI-u bytes it did not negotiate. The report itself still
  // encodes under the commit-time flags so the press/release pair stays
  // consistent.
  if ((context.currentKittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) === 0) {
    return null
  }
  // Why the key fallback: an input source can rewrite the keyup's `key`
  // ('Process' after a source switch mid-hold) while `code` still matches the
  // press; xterm's evaluate finds no encodable key there and would silently
  // drop the release, leaving the app with the key held forever. The keyup's
  // own single-char `key` wins (Shift-up-first correctly reports unshifted).
  const releaseKey =
    release.key.length === 1 || context.press === undefined
      ? release
      : { ...release, key: context.press.key, code: context.press.code ?? release.code }
  return evaluateKittyReport(releaseKey, release, obligation.flags, KITTY_EVENT_TYPE_RELEASE)
}
