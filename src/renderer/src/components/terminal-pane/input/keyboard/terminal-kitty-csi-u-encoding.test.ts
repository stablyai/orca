import { describe, expect, it } from 'vitest'
import {
  encodeTerminalKittyCsiU,
  encodeTerminalOptionKittyEvent
} from './terminal-kitty-csi-u-encoding'

const optionQ = {
  primaryCodePoint: 113,
  baseCodePoint: 113,
  shiftKey: false,
  altKey: true,
  ctrlKey: false,
  metaKey: false,
  associatedText: '@'
}

describe('terminal kitty CSI-u encoding', () => {
  it.each([
    [8, 'press', '\x1b[113;3u'],
    [10, 'repeat', '\x1b[113;3:2u'],
    [10, 'release', '\x1b[113;3:3u'],
    [24, 'press', '\x1b[113;3;64u'],
    [30, 'repeat', '\x1b[113;3:2;64u'],
    [30, 'release', '\x1b[113;3:3u']
  ] as const)('encodes flags %i %s', (flags, type, expected) => {
    expect(encodeTerminalKittyCsiU({ ...optionQ, flags, type })).toBe(expected)
  })
})

describe('terminal keyboard event CSI-u identity', () => {
  const keyboardEvent = (
    overrides: Partial<Parameters<typeof encodeTerminalOptionKittyEvent>[0]>
  ): Parameters<typeof encodeTerminalOptionKittyEvent>[0] => ({
    key: 'a',
    code: 'KeyA',
    shiftKey: false,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    ...overrides
  })

  it('derives unresolved shifted and CapsLock letter identities from native text', () => {
    expect(
      encodeTerminalOptionKittyEvent(keyboardEvent({ key: 'A', code: 'KeyQ', shiftKey: true }), {
        flags: 12,
        type: 'press',
        primaryCharacterFallback: 'A'
      })
    ).toBe('\x1b[97:65:113;2u')
    expect(
      encodeTerminalOptionKittyEvent(keyboardEvent({ key: 'A', code: 'KeyQ', capsLock: true }), {
        flags: 8,
        type: 'press',
        primaryCharacterFallback: 'A'
      })
    ).toBe('\x1b[97;65u')
    expect(
      encodeTerminalOptionKittyEvent(
        keyboardEvent({ key: 'M', code: 'Semicolon', shiftKey: true }),
        { flags: 14, type: 'press', primaryCharacterFallback: 'M' }
      )
    ).toBe('\x1b[109:77:59;2u')
    expect(
      encodeTerminalOptionKittyEvent(keyboardEvent({ key: 'm', code: 'Semicolon' }), {
        flags: 14,
        type: 'release',
        primaryCharacterFallback: 'm'
      })
    ).toBe('\x1b[109::59;1:3u')
    expect(
      encodeTerminalOptionKittyEvent(
        keyboardEvent({ key: 'M', code: 'Semicolon', capsLock: true }),
        { flags: 8, type: 'press', primaryCharacterFallback: 'M' }
      )
    ).toBe('\x1b[109;65u')
  })

  it.each([
    ['ArrowLeft', 'Numpad4', 57417],
    ['ArrowRight', 'Numpad6', 57418],
    ['ArrowUp', 'Numpad8', 57419],
    ['ArrowDown', 'Numpad2', 57420],
    ['PageUp', 'Numpad9', 57421],
    ['PageDown', 'Numpad3', 57422],
    ['Home', 'Numpad7', 57423],
    ['End', 'Numpad1', 57424],
    ['Insert', 'Numpad0', 57425],
    ['Delete', 'NumpadDecimal', 57426],
    ['Clear', 'Numpad5', 57427]
  ])('encodes keypad %s (%s) as functional code %i', (key, code, codePoint) => {
    const event = keyboardEvent({ key, code, altKey: true })
    expect(encodeTerminalOptionKittyEvent(event, { flags: 2, type: 'press' })).toBe(
      `\x1b[${codePoint};3u`
    )
    expect(encodeTerminalOptionKittyEvent(event, { flags: 2, type: 'release' })).toBe(
      `\x1b[${codePoint};3:3u`
    )
  })
})
