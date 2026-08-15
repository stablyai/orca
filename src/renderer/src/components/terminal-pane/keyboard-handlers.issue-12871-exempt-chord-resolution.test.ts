// Issue #12871, unit half: the decision boundary, including the negatives. Shapes here are
// constructed from the DOM contract; hardware fidelity lives in
// keyboard-handlers.issue-12871-recorded-chord-traces.test.ts, which replays captured macOS
// Korean and Japanese traces through the real handler and xterm. Why the two input sources need
// different answers is in `isImeExemptTerminalChord` (terminal-shortcut-policy.ts).
import { describe, expect, it } from 'vitest'
import { imeChordSnapshot, resolveTerminalKeyboardShortcutAction } from './keyboard-handlers'
import { isImeExemptTerminalChord, type TerminalShortcutEvent } from './terminal-shortcut-policy'

// `isComposing` alone decides ownership; `keyCode` is carried so each fixture reads as the
// shape hardware actually produces, matching the recorded traces in the sibling IME tests.
type ComposingKeyEvent = TerminalShortcutEvent & { isComposing: boolean; keyCode: number }

function keyEvent(overrides: Partial<ComposingKeyEvent>): ComposingKeyEvent {
  return {
    key: '',
    code: '',
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    keyCode: 0,
    ...overrides
  }
}

function resolveOnMac(
  event: ComposingKeyEvent
): ReturnType<typeof resolveTerminalKeyboardShortcutAction> {
  return resolveTerminalKeyboardShortcutAction(
    event,
    true,
    'false',
    0,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => false
  )
}

describe('terminal chords stay live during an IME composition', () => {
  it.each([
    ['Cmd+ArrowLeft', keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true }), '\x01'],
    ['Cmd+ArrowRight', keyEvent({ key: 'ArrowRight', code: 'ArrowRight', metaKey: true }), '\x05'],
    ['Cmd+Backspace', keyEvent({ key: 'Backspace', code: 'Backspace', metaKey: true }), '\x15'],
    ['Cmd+Delete', keyEvent({ key: 'Delete', code: 'Delete', metaKey: true }), '\x0b'],
    ['Option+ArrowLeft', keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', altKey: true }), '\x1bb'],
    [
      'Option+ArrowRight',
      keyEvent({ key: 'ArrowRight', code: 'ArrowRight', altKey: true }),
      '\x1bf'
    ]
  ])('resolves %s while a composition is live', (_label, event, expected) => {
    expect(resolveOnMac({ ...event, isComposing: true })).toEqual({
      type: 'sendInput',
      data: expected
    })
  })

  // Chromium keeps a KeyboardEvent's fields as accessors on the prototype, so a spread copies
  // nothing and the remembered chord loses its `code` — every swallowed chord then goes silently
  // undelivered. happy-dom keeps them as own properties, so replaying real events cannot see it.
  // Modelling the browser's shape explicitly is the only form of that check which runs here.
  it('copies fields that live only on the prototype, as a browser reports them', () => {
    const fields = {
      key: 'Process',
      code: 'ArrowLeft',
      metaKey: true,
      ctrlKey: false,
      altKey: false,
      shiftKey: false
    }
    const prototype = Object.create(
      null,
      Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, { get: () => value }])
      )
    ) as KeyboardEvent
    const event = Object.create(prototype) as KeyboardEvent
    // What a spread would have to work with.
    expect(Object.keys(event)).toEqual([])

    const chord = imeChordSnapshot(event)
    expect(chord.code).toBe('ArrowLeft')
    expect(chord.metaKey).toBe(true)
    // The code, not the rewritten `key`.
    expect(chord.key).toBe('ArrowLeft')
  })

  // The gate that decides whether a composing keydown is remembered for its release. Asserted
  // directly rather than through the resolver: the resolver answers for every binding in the
  // registry, so a new one landing there would break these rows for a reason unrelated to the
  // exemption. The exemption is for chords over a physical key, not for the IME's own gesture
  // keys — a composing Ctrl+Space mode switch reaches this as a lone Control keydown.
  it.each([
    ['lone Control', keyEvent({ key: 'Control', code: 'ControlLeft', keyCode: 17, ctrlKey: true })],
    ['lone Meta', keyEvent({ key: 'Meta', code: 'MetaLeft', keyCode: 91, metaKey: true })],
    ['bare ArrowLeft', keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft' })],
    // Japanese conversion binds Shift+Arrow to resize the segment being converted, so a
    // modifier alongside it does not make the chord ours.
    [
      'Cmd+Shift+ArrowLeft',
      keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true, shiftKey: true })
    ],
    ['Cmd+A', keyEvent({ key: 'a', code: 'KeyA', metaKey: true })]
  ])('does not remember %s for its release', (_label, event) => {
    expect(isImeExemptTerminalChord(event)).toBe(false)
  })

  it.each([
    ['Cmd+ArrowLeft', keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true })],
    ['Option+ArrowRight', keyEvent({ key: 'ArrowRight', code: 'ArrowRight', altKey: true })],
    // `key` is already rewritten here, which is why the gate reads `code`.
    ['Cmd+Backspace as Process', keyEvent({ key: 'Process', code: 'Backspace', metaKey: true })]
  ])('remembers %s for its release', (_label, event) => {
    expect(isImeExemptTerminalChord(event)).toBe(true)
  })
})
