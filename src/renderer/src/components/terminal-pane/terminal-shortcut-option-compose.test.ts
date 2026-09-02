import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'
import type { OptionKeyLocationState } from '../../lib/keyboard-layout/option-key-location-state'

function event(overrides: Partial<TerminalShortcutEvent>): TerminalShortcutEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  }
}

describe('Option-composed characters in kitty keyboard panes', () => {
  const resolveKitty = (
    input: TerminalShortcutEvent,
    macOptionAsAlt: 'true' | 'false' | 'left' | 'right' = 'false',
    optionKeyLocations: OptionKeyLocationState = 0,
    layoutCharacterForCode?: (code: string, shifted: boolean) => string | undefined,
    kittyKeyboardFlags = 1
  ) =>
    resolveTerminalShortcutAction(
      input,
      true,
      macOptionAsAlt,
      optionKeyLocations,
      false,
      undefined,
      undefined,
      () => kittyKeyboardFlags,
      layoutCharacterForCode
    )

  // Turkish-Q composes '@' on Option+Q and '$' on Option+4. Reporting them as
  // alt+q / alt+4 makes Codex's '@' references and '$' skills untypable (#14024).
  it('types the layout-composed ASCII character instead of reporting a chord', () => {
    expect(resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '@'
    })
    expect(resolveKitty(event({ key: '$', code: 'Digit4', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '$'
    })
  })

  it('types composed ASCII resolved through the active layout map', () => {
    // The map is the layout-true source; Option+Q must still type '@' when it
    // reports the base key rather than the US table doing so.
    const turkish = (code: string): string | undefined => (code === 'KeyQ' ? 'q' : undefined)
    expect(
      resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }), 'false', 0, turkish)
    ).toEqual({ type: 'sendInput', data: '@' })
  })

  it('types composed ASCII that needs Shift as well', () => {
    // German composes '\' on Option+Shift+7.
    const german = (code: string, shifted: boolean): string | undefined =>
      code === 'Digit7' ? (shifted ? '/' : '7') : undefined
    expect(
      resolveKitty(
        event({ key: '\\', code: 'Digit7', altKey: true, shiftKey: true }),
        'false',
        0,
        german
      )
    ).toEqual({ type: 'sendInput', data: '\\' })
  })

  it('types a dead-key-layer ASCII character with event reporting balanced', () => {
    const abc = (code: string, shifted: boolean): string | undefined =>
      code === 'Backquote' ? (shifted ? '~' : '`') : undefined
    expect(
      resolveKitty(
        event({ key: '`', code: 'Backquote', altKey: true, shiftKey: true }),
        'false',
        0,
        abc,
        2
      )
    ).toEqual({ type: 'sendInput', data: '`', optionKittyRelease: { flags: 2 } })
  })

  it('keeps Shift-only ASCII as an Option hotkey', () => {
    const latvian = (code: string, shifted: boolean): string | undefined =>
      code === 'Digit2' ? (shifted ? '@' : '2') : undefined
    expect(
      resolveKitty(
        event({ key: '@', code: 'Digit2', altKey: true, shiftKey: true }),
        'false',
        0,
        latvian
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[50;4u' })
  })

  it('tracks a compose-side dead key while preserving its native keydown', () => {
    const abc = (code: string, shifted: boolean): string | undefined =>
      code === 'KeyE' ? (shifted ? 'E' : 'e') : undefined
    expect(
      resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }), 'false', 0, abc, 30)
    ).toEqual({ type: 'trackNativeOptionDeadKey' })
    expect(
      resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }), 'left', 2, abc, 2)
    ).toEqual({ type: 'trackNativeOptionDeadKey' })
    expect(
      resolveKitty(
        event({ key: 'Dead', code: 'KeyE', altKey: true, shiftKey: true }),
        'left',
        1,
        abc,
        30
      )
    ).toEqual({ type: 'trackNativeOptionDeadKey' })
    // Global Option-as-Alt stays with the terminal engine, which may send the press.
    expect(
      resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }), 'true', 0, abc, 30)
    ).toBeNull()
  })

  it.each([
    { key: 'Process', code: 'KeyQ' },
    { key: 'Unidentified', code: 'KeyQ' },
    { key: '@', code: 'KeyQ', isComposing: true },
    { key: '@', code: 'KeyQ', keyCode: 229 }
  ])('leaves IME-owned events to the text-input path', (overrides) => {
    expect(
      resolveKitty(event({ ...overrides, altKey: true }), 'false', 0, undefined, 30)
    ).toBeNull()
  })

  it('still reports non-ASCII Option chords as kitty CSI-u hotkeys', () => {
    // #8031: compose layouts must keep reaching TUI Option hotkeys, and every
    // glyph those layouts compose on a bound key is non-ASCII.
    expect(resolveKitty(event({ key: 'ƒ', code: 'KeyF', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[102;3u'
    })
    expect(resolveKitty(event({ key: '∫', code: 'KeyB', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[98;3u'
    })
    expect(resolveKitty(event({ key: 'å', code: 'KeyA', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[97;3u'
    })
  })

  it('reports a chord when the layout composed nothing and echoed the base key', () => {
    // No composition happened, so this is a hotkey — not a request to type 'q'.
    expect(resolveKitty(event({ key: 'q', code: 'KeyQ', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[113;3u'
    })
    expect(resolveKitty(event({ key: 'Q', code: 'KeyQ', altKey: true, shiftKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[113;4u'
    })
  })

  it('keeps the configured Alt-side Option a hotkey even when the layout composed ASCII', () => {
    // The user asked for left Option to be Alt; macOS still composes, but their setting wins.
    expect(resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }), 'left', 1)).toEqual({
      type: 'sendInput',
      data: '\x1b[113;3u'
    })
    // The compose-side Option in the same mode still types the character.
    expect(resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }), 'left', 2)).toEqual({
      type: 'sendInput',
      data: '@'
    })
    expect(resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }), 'left', 1)).toEqual({
      type: 'sendInput',
      data: '\x1be'
    })
    expect(
      resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }), 'left', 1, undefined, 2)
    ).toEqual({ type: 'sendInput', data: '\x1be', consumeOptionKeyUp: true })
  })

  it('keeps global Option-as-Alt in the centralized encoder without associated text', () => {
    expect(
      resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }), 'true', 0, undefined, 24)
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[113;3u'
    })
  })

  it('uses the active layout for side-specific Option-as-Alt without kitty reporting', () => {
    const layout = (code: string): string | undefined => (code === 'KeyN' ? 'b' : undefined)
    expect(
      resolveKitty(event({ key: '∫', code: 'KeyN', altKey: true }), 'left', 1, layout, 0)
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
  })

  it('leaves global legacy Option-as-Alt with the terminal engine', () => {
    expect(
      resolveKitty(event({ key: '∫', code: 'KeyN', altKey: true }), 'true', 0, undefined, 0)
    ).toBeNull()
  })

  it.each([4, 16])('keeps configured Alt legacy encoding for form-only flag %i', (flags) => {
    const chord = event({ key: '@', code: 'KeyQ', altKey: true })
    expect(resolveKitty(chord, 'true', 0, undefined, flags)).toEqual({
      type: 'sendInput',
      data: '\x1bq'
    })
    expect(resolveKitty(chord, 'left', 1, undefined, flags)).toEqual({
      type: 'sendInput',
      data: '\x1bq'
    })
  })

  it('keeps unknown or dual Option state conservative in side-specific modes', () => {
    const chord = event({ key: '@', code: 'KeyQ', altKey: true })
    expect(resolveKitty(chord, 'left', 0)).toEqual({ type: 'sendInput', data: '\x1b[113;3u' })
    expect(resolveKitty(chord, 'left', 3)).toEqual({ type: 'sendInput', data: '\x1b[113;3u' })
  })

  it.each([
    [8, '\x1b[113;3u'],
    [9, '\x1b[113;3u'],
    [10, '\x1b[113;3u'],
    [15, '\x1b[113;3u'],
    [24, '\x1b[113;3;64u']
  ] as const)('preserves report-all kitty flags %i', (flags, expected) => {
    const action = resolveKitty(
      event({ key: '@', code: 'KeyQ', altKey: true }),
      'false',
      0,
      undefined,
      flags
    )
    expect(action).toMatchObject({ type: 'sendInput', data: expected })
    expect(action?.type === 'sendInput' ? action.optionKittyRelease : undefined).toEqual(
      (flags & 2) === 0 ? undefined : { flags }
    )
  })

  it('reports repeats and associated text without changing the physical key identity', () => {
    expect(
      resolveKitty(
        event({ key: '@', code: 'KeyQ', altKey: true, repeat: true }),
        'false',
        0,
        undefined,
        30
      )
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[113;3:2;64u',
      optionKittyRelease: { flags: 30 }
    })
  })

  it('pairs raw composed text with a native-Option kitty release', () => {
    expect(
      resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }), 'false', 0, undefined, 2)
    ).toEqual({
      type: 'sendInput',
      data: '@',
      optionKittyRelease: { flags: 2 }
    })
  })

  it('uses no-Option layout layers for alternate-key reports', () => {
    const german = (code: string, shifted: boolean): string | undefined =>
      code === 'Digit7' ? (shifted ? '/' : '7') : undefined
    expect(
      resolveKitty(
        event({ key: '\\', code: 'Digit7', altKey: true, shiftKey: true }),
        'false',
        0,
        german,
        30
      )
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[55:47;4;92u',
      optionKittyRelease: { flags: 30 }
    })
  })

  it('encodes ISO and Space keys from the active layout', () => {
    const layout = (code: string, shifted: boolean): string | undefined =>
      code === 'IntlBackslash' ? (shifted ? '>' : '<') : code === 'Space' ? ' ' : undefined
    expect(
      resolveKitty(event({ key: '|', code: 'IntlBackslash', altKey: true }), 'false', 0, layout, 30)
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[60;3;124u',
      optionKittyRelease: { flags: 30 }
    })
    expect(
      resolveKitty(event({ key: '\u00a0', code: 'Space', altKey: true }), 'false', 0, layout, 30)
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[32;3;160u',
      optionKittyRelease: { flags: 30 }
    })
  })

  it('preserves functional numpad identity under modified-key reporting', () => {
    expect(
      resolveKitty(event({ key: '1', code: 'Numpad1', altKey: true }), 'false', 0, undefined, 2)
    ).toEqual({
      type: 'sendInput',
      data: '\x1b[57400;3u',
      optionKittyRelease: { flags: 2 }
    })
  })

  it.each([
    ['ArrowLeft', 'Numpad4', 57417],
    ['Delete', 'NumpadDecimal', 57426],
    ['Clear', 'Numpad5', 57427]
  ])('preserves NumLock-off %s keypad identity', (key, code, codePoint) => {
    expect(resolveKitty(event({ key, code, altKey: true }), 'false', 0, undefined, 2)).toEqual({
      type: 'sendInput',
      data: `\x1b[${codePoint};3u`,
      optionKittyRelease: { flags: 2 }
    })
  })

  it('includes CapsLock in Option protocol modifiers', () => {
    expect(
      resolveKitty(
        event({
          key: '@',
          code: 'KeyQ',
          altKey: true,
          getModifierState: (modifier) => modifier === 'CapsLock'
        }),
        'false',
        0,
        undefined,
        24
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[113;67;64u' })
  })

  it('types shifted ASCII when the layout resolves the physical key for the keyup', () => {
    const german = (code: string, shifted: boolean): string | undefined =>
      code === 'Digit7' ? (shifted ? '/' : '7') : undefined
    expect(
      resolveKitty(
        event({ key: '\\', code: 'Digit7', altKey: true, shiftKey: true }),
        'false',
        0,
        german,
        2
      )
    ).toEqual({
      type: 'sendInput',
      data: '\\',
      optionKittyRelease: { flags: 2 }
    })
  })

  it('prefers composed text while the shifted layout snapshot is pending', () => {
    expect(
      resolveKitty(
        event({ key: '\\', code: 'Digit7', altKey: true, shiftKey: true }),
        'false',
        0,
        undefined,
        2
      )
    ).toEqual({
      type: 'sendInput',
      data: '\\',
      optionKittyRelease: { flags: 2 }
    })

    expect(
      resolveKitty(
        event({ key: '\\', code: 'Digit7', altKey: true, shiftKey: true }),
        'left',
        1,
        undefined,
        2
      )
    ).toEqual({ type: 'sendInput', data: '\x1b[55;4u', optionKittyRelease: { flags: 2 } })
  })

  it('omits associated text for an Option side configured as Alt', () => {
    expect(
      resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }), 'left', 1, undefined, 24)
    ).toEqual({ type: 'sendInput', data: '\x1b[113;3u' })
  })
})
