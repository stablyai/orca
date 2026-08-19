import type { OptionKeyLocationState } from '../../lib/keyboard-layout/option-key-location-state'
import {
  KITTY_DISAMBIGUATE_ESCAPE_CODES,
  KITTY_REPORT_EVENT_TYPES,
  kittyReportsAllKeysAsEscapeCodes
} from '../../../../shared/terminal-kitty-keyboard-flags'
import {
  encodeTerminalOptionKittyEvent,
  optionKittyPrimaryCharacterFallback,
  pc101CharacterForCode
} from './terminal-kitty-csi-u-encoding'
import type { TerminalOptionKittyRelease } from './terminal-option-kitty-release'

export type MacOptionAsAlt = 'true' | 'false' | 'left' | 'right'

type TerminalOptionShortcutEvent = {
  key: string
  code?: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
  repeat?: boolean
  isComposing?: boolean
  keyCode?: number
  getModifierState?: (key: string) => boolean
}

export type TerminalOptionShortcutAction =
  | {
      type: 'sendInput'
      data: string
      optionKittyRelease?: TerminalOptionKittyRelease
      consumeOptionKeyUp?: boolean
    }
  | { type: 'trackNativeOptionDeadKey' }

type TerminalOptionShortcutContext = {
  isMac: boolean
  macOptionAsAlt: MacOptionAsAlt
  optionKeyLocations: OptionKeyLocationState
  getKittyKeyboardFlags: () => number
  layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined
}

function createRelease(flags: number): TerminalOptionKittyRelease | undefined {
  return (flags & KITTY_REPORT_EVENT_TYPES) === 0 ? undefined : { flags }
}

// Why ASCII-only: the protocol says a text-producing key sends its text, but #8031 needs Option
// hotkeys to still reach kitty TUIs. ASCII splits the two — layouts hide `@ $ # [ ] { } \ |` behind
// Option with no other way to type them, while the glyphs on TUI-bound keys (π, ƒ, ∫) never are.
function isLayoutComposedAsciiCharacter(
  key: string,
  characterWithoutOption: string | undefined
): boolean {
  if (key.length !== 1) {
    return false
  }
  const codePoint = key.codePointAt(0) as number
  return (
    codePoint > 0x20 &&
    codePoint <= 0x7e &&
    (characterWithoutOption === undefined ||
      key.toLowerCase() !== characterWithoutOption.toLowerCase())
  )
}

function isImeOwnedKey(event: TerminalOptionShortcutEvent): boolean {
  return (
    event.isComposing === true ||
    event.keyCode === 229 ||
    event.key === 'Dead' ||
    event.key === 'Process' ||
    event.key === 'Unidentified'
  )
}

function kittyEncodesModifiedTextKeys(flags: number): boolean {
  return (
    kittyReportsAllKeysAsEscapeCodes(flags) ||
    (flags & (KITTY_DISAMBIGUATE_ESCAPE_CODES | KITTY_REPORT_EVENT_TYPES)) !== 0
  )
}

export function resolveTerminalOptionShortcutAction(
  event: TerminalOptionShortcutEvent,
  context: TerminalOptionShortcutContext
): TerminalOptionShortcutAction | null {
  if (!context.isMac || event.metaKey || event.ctrlKey || !event.altKey) {
    return null
  }
  const isLeftOption = (context.optionKeyLocations & 1) !== 0
  const isRightOption = (context.optionKeyLocations & 2) !== 0
  const shouldActAsMeta =
    context.macOptionAsAlt === 'true' ||
    (context.macOptionAsAlt === 'left' && isLeftOption) ||
    (context.macOptionAsAlt === 'right' && isRightOption)
  const canSendComposedText =
    context.macOptionAsAlt === 'false' ||
    (context.macOptionAsAlt === 'left' && !isLeftOption && isRightOption) ||
    (context.macOptionAsAlt === 'right' && isLeftOption && !isRightOption)
  const configuredSideOwnsDeadKey =
    event.key === 'Dead' && context.macOptionAsAlt !== 'true' && shouldActAsMeta && !event.shiftKey
  const flags = context.getKittyKeyboardFlags()
  if (event.key === 'Dead' && context.macOptionAsAlt !== 'true' && !configuredSideOwnsDeadKey) {
    return (flags & KITTY_REPORT_EVENT_TYPES) === 0 ? null : { type: 'trackNativeOptionDeadKey' }
  }
  if (isImeOwnedKey(event) && !configuredSideOwnsDeadKey) {
    return null
  }

  if (context.macOptionAsAlt === 'true' && flags === 0) {
    return null
  }
  if (event.key !== 'Dead' && kittyEncodesModifiedTextKeys(flags)) {
    const isNumpad = event.code?.startsWith('Numpad') === true
    const primaryCharacterFallback = optionKittyPrimaryCharacterFallback(event)
    const baseCharacter =
      (event.code ? context.layoutCharacterForCode?.(event.code, false) : undefined) ??
      pc101CharacterForCode(event.code)
    const characterWithoutOption = event.code
      ? (context.layoutCharacterForCode?.(event.code, event.shiftKey) ??
        (!event.shiftKey
          ? baseCharacter
          : event.code.startsWith('Key')
            ? baseCharacter?.toUpperCase()
            : undefined))
      : undefined
    if (
      !kittyReportsAllKeysAsEscapeCodes(flags) &&
      canSendComposedText &&
      !isNumpad &&
      isLayoutComposedAsciiCharacter(event.key, characterWithoutOption)
    ) {
      return { type: 'sendInput', data: event.key, optionKittyRelease: createRelease(flags) }
    }

    if (baseCharacter || isNumpad || primaryCharacterFallback) {
      const data = encodeTerminalOptionKittyEvent(event, {
        flags,
        type: event.repeat === true ? 'repeat' : 'press',
        layoutCharacterForCode: context.layoutCharacterForCode,
        primaryCharacterFallback,
        associatedText:
          kittyReportsAllKeysAsEscapeCodes(flags) && canSendComposedText ? event.key : undefined
      })
      if (data) {
        return { type: 'sendInput', data, optionKittyRelease: createRelease(flags) }
      }
    }
  }

  if (!event.shiftKey) {
    if (shouldActAsMeta) {
      const character =
        (event.code ? context.layoutCharacterForCode?.(event.code, false) : undefined) ??
        pc101CharacterForCode(event.code)
      if (character) {
        return {
          type: 'sendInput',
          data: `\x1b${character}`,
          ...(configuredSideOwnsDeadKey && (flags & KITTY_REPORT_EVENT_TYPES) !== 0
            ? { consumeOptionKeyUp: true }
            : {})
        }
      }
    }
    if (!shouldActAsMeta) {
      if (event.code === 'KeyB') {
        return { type: 'sendInput', data: '\x1bb' }
      }
      if (event.code === 'KeyF') {
        return { type: 'sendInput', data: '\x1bf' }
      }
      if (event.code === 'KeyD') {
        return { type: 'sendInput', data: '\x1bd' }
      }
    }
  }
  if (
    event.key === 'Dead' &&
    context.macOptionAsAlt !== 'true' &&
    (flags & KITTY_REPORT_EVENT_TYPES) !== 0
  ) {
    return { type: 'trackNativeOptionDeadKey' }
  }
  return null
}
