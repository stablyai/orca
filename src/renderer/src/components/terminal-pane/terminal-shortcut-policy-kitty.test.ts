import { describe, expect, it } from 'vitest'
import {
  resolveTerminalShortcutAction,
  type TerminalShortcutEvent
} from './terminal-shortcut-policy'

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
describe('kitty keyboard protocol panes', () => {
  const kittyActive = (): boolean => true
  const kittyInactive = (): boolean => false

  const resolveKitty = (
    input: TerminalShortcutEvent,
    macOptionAsAlt: 'true' | 'false' | 'left' | 'right' = 'false',
    optionKeyLocation = 0,
    active: () => boolean = kittyActive
  ) =>
    resolveTerminalShortcutAction(
      input,
      true,
      macOptionAsAlt,
      optionKeyLocation,
      false,
      undefined,
      undefined,
      active
    )

  it('encodes Option+letter as kitty CSI-u with the physical base key in compose mode', () => {
    // macOS composition reports key='π' for Option+P on ABC/compose layouts;
    // OMP binds alt+p (temporary model) and alt+m (model selector).
    expect(resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })
    expect(resolveKitty(event({ key: 'µ', code: 'KeyM', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[109;3u'
    })
  })

  it('includes shift in the kitty modifier field', () => {
    expect(resolveKitty(event({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[112;4u'
    })
  })

  it('encodes Option+digit and mapped Option+punctuation', () => {
    expect(resolveKitty(event({ key: '¡', code: 'Digit1', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[49;3u'
    })
    expect(resolveKitty(event({ key: '≥', code: 'Period', altKey: true }))).toEqual({
      type: 'sendInput',
      data: '\x1b[46;3u'
    })
  })

  it('exempts dead keys so Option composition still starts', () => {
    expect(resolveKitty(event({ key: 'Dead', code: 'KeyE', altKey: true }))).toBeNull()
  })

  it('defers to xterm in macOptionAsAlt=true mode (native kitty encoding is correct there)', () => {
    expect(resolveKitty(event({ key: 'p', code: 'KeyP', altKey: true }), 'true')).toBeNull()
  })

  it('keeps shift+Option composition untouched in non-kitty panes', () => {
    expect(
      resolveKitty(
        event({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }),
        'false',
        0,
        kittyInactive
      )
    ).toBeNull()
    // Meta-side Option in 'left' mode stays shift-exempt without kitty.
    expect(
      resolveKitty(
        event({ key: '∏', code: 'KeyP', altKey: true, shiftKey: true }),
        'left',
        1,
        kittyInactive
      )
    ).toBeNull()
  })

  it('keeps compose-mode behavior unchanged when the pane is not kitty-active', () => {
    expect(
      resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true }), 'false', 0, kittyInactive)
    ).toBeNull()
    // The B/F/D readline patches still apply without kitty.
    expect(
      resolveKitty(event({ key: '∫', code: 'KeyB', altKey: true }), 'false', 0, kittyInactive)
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
  })

  it('encodes the compose-side Option key as kitty CSI-u in left/right modes', () => {
    // In 'left' mode the right Option normally composes; a kitty pane asked
    // for modifier-accurate keys, so it gets alt-encoded too.
    expect(resolveKitty(event({ key: '¬', code: 'KeyL', altKey: true }), 'left', 2)).toEqual({
      type: 'sendInput',
      data: '\x1b[108;3u'
    })
    // The designated meta side upgrades from legacy Esc+letter to CSI-u.
    expect(resolveKitty(event({ key: '¬', code: 'KeyL', altKey: true }), 'left', 1)).toEqual({
      type: 'sendInput',
      data: '\x1b[108;3u'
    })
  })

  it('yields Alt+Arrow and Alt+Backspace to xterm kitty encoding', () => {
    expect(resolveKitty(event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }))).toBeNull()
    expect(resolveKitty(event({ key: 'Backspace', code: 'Backspace', altKey: true }))).toBeNull()
    // Without kitty, the readline translations still apply.
    expect(
      resolveKitty(
        event({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }),
        'false',
        0,
        kittyInactive
      )
    ).toEqual({ type: 'sendInput', data: '\x1bb' })
    expect(
      resolveKitty(
        event({ key: 'Backspace', code: 'Backspace', altKey: true }),
        'false',
        0,
        kittyInactive
      )
    ).toEqual({ type: 'sendInput', data: '\x1b\x7f' })
  })

  it('does not intercept Option chords with Cmd or Ctrl held', () => {
    expect(resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true, metaKey: true }))).toBeNull()
    expect(resolveKitty(event({ key: 'π', code: 'KeyP', altKey: true, ctrlKey: true }))).toBeNull()
  })

  it('resolves the kitty base key through the active layout map when provided', () => {
    const resolveWithLayout = (
      input: TerminalShortcutEvent,
      layoutBaseCharacterForCode: (code: string) => string | undefined
    ) =>
      resolveTerminalShortcutAction(
        input,
        true,
        'false',
        0,
        false,
        undefined,
        undefined,
        kittyActive,
        layoutBaseCharacterForCode
      )

    // AZERTY types M at the physical Semicolon position; the layout map must
    // win over the US punctuation table so the chord reports alt+m, not alt+;.
    const azerty = (code: string): string | undefined => (code === 'Semicolon' ? 'm' : undefined)
    expect(resolveWithLayout(event({ key: 'µ', code: 'Semicolon', altKey: true }), azerty)).toEqual(
      { type: 'sendInput', data: '\x1b[109;3u' }
    )

    // Colemak types P at the physical KeyR position.
    const colemak = (code: string): string | undefined => (code === 'KeyR' ? 'p' : undefined)
    expect(resolveWithLayout(event({ key: 'π', code: 'KeyR', altKey: true }), colemak)).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })

    // Falls back to the US table when the layout map has no entry.
    const empty = (): string | undefined => undefined
    expect(resolveWithLayout(event({ key: 'π', code: 'KeyP', altKey: true }), empty)).toEqual({
      type: 'sendInput',
      data: '\x1b[112;3u'
    })
  })
})
