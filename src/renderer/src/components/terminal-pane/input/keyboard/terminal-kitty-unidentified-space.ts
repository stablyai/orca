import { encodeTerminalKittyCsiU } from './terminal-kitty-csi-u-encoding'
import { kittyEncodesModifiedTextKeys } from './terminal-option-shortcut-policy'
import type { XtermBypassEvent } from './xterm-bypass-policy'

function encodeSpace(
  event: XtermBypassEvent,
  flags: number,
  type: 'press' | 'repeat' | 'release'
): string | null {
  return encodeTerminalKittyCsiU({
    flags,
    type,
    primaryCodePoint: 0x20,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey
  })
}

/** Chromium on Linux Wayland names Ctrl+Space `Unidentified`; xterm's Kitty encoder reads only `key` and sends nothing (#23215). Recover Space from code; null leaves the keydown to xterm. */
export function resolveKittyUnidentifiedSpacePress(
  event: XtermBypassEvent,
  flags: number
): string | null {
  if (
    event.type !== 'keydown' ||
    event.code !== 'Space' ||
    event.key !== 'Unidentified' ||
    !event.ctrlKey ||
    !kittyEncodesModifiedTextKeys(flags)
  ) {
    return null
  }
  return encodeSpace(event, flags, event.repeat ? 'repeat' : 'press')
}

/** xterm never saw the claimed press, so its release is reported here; null when the app reports no event types. */
export function encodeKittyUnidentifiedSpaceRelease(
  event: XtermBypassEvent,
  flags: number
): string | null {
  return encodeSpace(event, flags, 'release')
}
