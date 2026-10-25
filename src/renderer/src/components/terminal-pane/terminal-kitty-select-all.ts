import { KITTY_REPORT_EVENT_TYPES } from '../../../../shared/terminal-kitty-keyboard-flags'
import {
  encodeTerminalKittyCsiU,
  encodeTerminalOptionKittyEvent
} from './terminal-kitty-csi-u-encoding'
import type { TerminalOptionKittyRelease } from './terminal-option-kitty-release'

type TerminalSelectAllKeyEvent = Parameters<typeof encodeTerminalOptionKittyEvent>[0]

type LayoutCharacterResolver = (code: string, shifted: boolean) => string | undefined

const LATIN_SMALL_A = 0x61

/**
 * Why: an app that negotiated the kitty keyboard protocol (Claude Code, opencode, Codex)
 * can bind Super+A to "select my input"; selecting the whole scrollback would steal the
 * chord from it. Mac-only because only there the select-all chord carries Super (Cmd);
 * Ctrl+Shift+A elsewhere stays Orca's select-all.
 */
export function shouldForwardSelectAllToKittyApp(isMac: boolean, kittyFlags: number): boolean {
  return isMac && kittyFlags > 0
}

type LockFreeKeyEvent = {
  key: string
  code?: string
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  repeat?: boolean
  getModifierState?: (key: string) => boolean
  capsLock?: boolean
  numLock?: boolean
}

/**
 * A copy of the key event with CapsLock/NumLock reported off. Why: `key`, `code` and the
 * modifier flags of a native KeyboardEvent are prototype getters an object spread drops, and
 * `getModifierState` must keep the native event as its receiver.
 */
export function withoutKittyLockModifiers<E extends LockFreeKeyEvent>(event: E): E {
  return {
    ...event,
    key: event.key,
    code: event.code,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    getModifierState: (key: string) => event.getModifierState?.(key) ?? false,
    capsLock: false,
    numLock: false
  }
}

/** Encodes the select-all keydown (Cmd+A by default) as the kitty CSI-u the app asked for. */
export function encodeTerminalSelectAllKittyKeyDown(
  event: TerminalSelectAllKeyEvent,
  kittyFlags: number,
  layoutCharacterForCode?: LayoutCharacterResolver
): string | null {
  return encodeTerminalOptionKittyEvent(
    // Why: xterm's own kitty encoder (what terminal-first uses) never reports lock modifiers;
    // matching it keeps CapsLock from turning `97;9u` into a `97;73u` apps do not bind.
    withoutKittyLockModifiers(event),
    {
      flags: kittyFlags,
      type: event.repeat ? 'repeat' : 'press',
      layoutCharacterForCode
    }
  )
}

/**
 * The keyup release a forwarded select-all press owes the app. Why: the press never reaches
 * xterm, so the orphan-keyup guard drops the physical keyup; without event types nothing is owed.
 */
export function selectAllKittyRelease(kittyFlags: number): TerminalOptionKittyRelease | undefined {
  return (kittyFlags & KITTY_REPORT_EVENT_TYPES) === 0
    ? undefined
    : { flags: kittyFlags, ignoreLockModifiers: true }
}

/**
 * Edit > Select All has no key event, so it sends a canonical Cmd+A tap: the press, plus the
 * release when the app asked for event types, so it never sees Super+A stuck down.
 */
export function encodeTerminalMenuSelectAllKitty(kittyFlags: number): string {
  const key = {
    flags: kittyFlags,
    primaryCodePoint: LATIN_SMALL_A,
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: true
  }
  const press = encodeTerminalKittyCsiU({ ...key, type: 'press' }) ?? ''
  const release = encodeTerminalKittyCsiU({ ...key, type: 'release' }) ?? ''
  return press + release
}
