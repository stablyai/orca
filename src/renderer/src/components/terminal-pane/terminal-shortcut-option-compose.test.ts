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

  // Turkish Option composition must type @/$ rather than Codex hotkeys (#14024).
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

  it('keeps the configured Alt-side Option a hotkey even when the layout composed ASCII', () => {
    expect(resolveKitty(event({ key: '@', code: 'KeyQ', altKey: true }), 'left', 1)).toEqual({
      type: 'sendInput',
      data: '\x1b[113;3u'
    })
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
})
