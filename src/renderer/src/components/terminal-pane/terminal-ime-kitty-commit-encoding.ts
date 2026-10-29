import {
  KITTY_DISAMBIGUATE_ESCAPE_CODES,
  KITTY_REPORT_EVENT_TYPES,
  kittyReportsAllKeysAsEscapeCodes
} from '../../../../shared/terminal-kitty-keyboard-flags'
import {
  encodeTerminalOptionKittyEvent,
  kittyFunctionalNumpadCodePointForEvent,
  resolveTerminalKittyPrimaryCodePoint
} from './terminal-kitty-csi-u-encoding'

/** The physical keydown that produced a commit, captured before the input event. */
export type ImeCommitKeyPress = {
  key: string
  code?: string
  shiftKey: boolean
  /** An auto-repeat keydown; the protocol distinguishes it from a fresh press. */
  repeat?: boolean
  capsLock?: boolean
  numLock?: boolean
}

/** Read actual keyup fields: Shift can release first, so press-time modifiers would misreport the release. */
export type ImeReleaseKeyEvent = {
  key: string
  code?: string
  shiftKey: boolean
  ctrlKey?: boolean
  altKey?: boolean
  metaKey?: boolean
  capsLock?: boolean
  numLock?: boolean
}

/** Encoder-owned release proof carries commit-time flags; forwarders must not reinterpret bits or rebuild CSI-u. */
export type ImeCommitReleaseObligation = {
  readonly flags: number
  readonly primaryCodePoint: number
}

export type ImeCommitKittyEncoding = {
  /** CSI-u press/repeat report, or null when the commit goes out as raw text. */
  report: string | null
  /** Non-null when the commit-time flags requested press/repeat/release events. */
  release: ImeCommitReleaseObligation | null
}

/** Bit 3 requests printable CSI-u; functional numpad keys also report under disambiguation/events. Bit 1 independently owes release for raw text. Keep physical key identity, with bit 4 carrying committed text, including multiple codepoints. */
export function encodeImeCommitForKitty(
  press: ImeCommitKeyPress | null,
  kittyKeyboardFlags: number,
  context: {
    committedText: string
    layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined
  }
): ImeCommitKittyEncoding {
  if (!press) {
    return { report: null, release: null }
  }
  const keyboardEvent = {
    ...press,
    altKey: false,
    ctrlKey: false,
    metaKey: false
  }
  const primaryCodePoint = resolveTerminalKittyPrimaryCodePoint(keyboardEvent, {
    layoutCharacterForCode: context.layoutCharacterForCode,
    primaryCharacterFallback: press.key
  })
  const reportsNumpadPress =
    kittyFunctionalNumpadCodePointForEvent(press) !== undefined &&
    (kittyKeyboardFlags & (KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES)) !== 0
  const report =
    !kittyReportsAllKeysAsEscapeCodes(kittyKeyboardFlags) && !reportsNumpadPress
      ? null
      : encodeTerminalOptionKittyEvent(keyboardEvent, {
          flags: kittyKeyboardFlags,
          type: press.repeat === true ? 'repeat' : 'press',
          layoutCharacterForCode: context.layoutCharacterForCode,
          associatedText: context.committedText,
          primaryCharacterFallback: press.key,
          primaryCodePoint
        })
  return {
    report,
    release:
      (kittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) === 0 || primaryCodePoint === undefined
        ? null
        : { flags: kittyKeyboardFlags, primaryCodePoint }
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
    layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined
  }
): string | null {
  // Require current event reporting so a mode pop cannot leak release bytes into the successor; encode with commit-time flags to match the press.
  if ((context.currentKittyKeyboardFlags & KITTY_REPORT_EVENT_TYPES) === 0) {
    return null
  }
  // Rewritten keyup keys such as Process need the press fallback to avoid a stuck key; actual single-character keyup still wins when Shift released first.
  const releaseKey =
    release.key.length === 1 || context.press === undefined
      ? release
      : { ...release, key: context.press.key, code: context.press.code ?? release.code }
  return encodeTerminalOptionKittyEvent(
    {
      ...releaseKey,
      altKey: release.altKey === true,
      ctrlKey: release.ctrlKey === true,
      metaKey: release.metaKey === true
    },
    {
      flags: obligation.flags,
      type: 'release',
      layoutCharacterForCode: context.layoutCharacterForCode,
      primaryCharacterFallback: releaseKey.key,
      primaryCodePoint: obligation.primaryCodePoint
    }
  )
}
