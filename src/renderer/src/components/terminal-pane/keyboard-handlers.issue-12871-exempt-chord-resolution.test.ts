// Issue #12871. Unit half: which events the shortcut layer still resolves while a composition
// is live. The end-to-end half lives in keyboard-handlers.issue-12871-recorded-chord-traces.test.ts,
// which replays captured macOS Korean and Japanese traces through the real handler and xterm.
//
// The exemption exists because a Japanese conversion swallows a modifier chord outright — no
// commit, no platform replay, nothing reaches the shell. It is what lets the pane resolve such
// a chord from its *release*; on the keydown the pane still yields, because Korean's input
// source replays the chord instead and acting on both copies would fire it twice.
//
// Scope: shapes here are constructed from the DOM contract, not captured. The captured file is
// where hardware fidelity lives; this file pins the decision boundary, including the negatives.
import { describe, expect, it } from 'vitest'
import { resolveTerminalKeyboardShortcutAction } from './keyboard-handlers'
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

  // Chromium defines KeyboardEvent's fields as accessors on the prototype, not as own
  // properties, so anything that copies an event by enumerating it gets nothing. happy-dom
  // does the opposite, which means a plain-object fixture cannot see that class of bug and a
  // real `new KeyboardEvent(...)` cannot either under this runner. Modelling the browser's
  // shape explicitly is the only form of it that runs here.
  it('resolves an event whose fields live on the prototype, as in a browser', () => {
    const fields = keyEvent({
      key: 'Process',
      code: 'Backspace',
      metaKey: true,
      isComposing: true,
      keyCode: 229
    })
    const prototype = Object.create(
      null,
      Object.fromEntries(
        Object.entries(fields).map(([name, value]) => [name, { get: () => value }])
      )
    ) as ComposingKeyEvent
    const event = Object.create(prototype) as ComposingKeyEvent
    expect(Object.keys(event)).toEqual([])

    expect(
      resolveTerminalKeyboardShortcutAction(
        event,
        true,
        'false',
        0,
        false,
        { 'terminal.clear': ['Mod+Backspace'] },
        undefined,
        undefined,
        undefined,
        undefined,
        () => false
      )
    ).toEqual({ type: 'clearActivePane' })
  })

  // A CJK input source rewrites `key` while `code` keeps the physical key, which is what
  // #12171 and #13033 turned on. Matching `key` here would drop the chord again.
  it('matches the physical code when the input source has rewritten key', () => {
    const event = keyEvent({
      key: 'Process',
      code: 'ArrowLeft',
      metaKey: true,
      isComposing: true,
      keyCode: 229
    })

    expect(resolveOnMac(event)).toEqual({ type: 'sendInput', data: '\x01' })
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
    expect(isImeExemptTerminalChord({ ...event, isComposing: true })).toBe(false)
  })

  it.each([
    ['Cmd+ArrowLeft', keyEvent({ key: 'ArrowLeft', code: 'ArrowLeft', metaKey: true })],
    ['Option+ArrowRight', keyEvent({ key: 'ArrowRight', code: 'ArrowRight', altKey: true })],
    // `key` is already rewritten here, which is why the gate reads `code`.
    ['Cmd+Backspace as Process', keyEvent({ key: 'Process', code: 'Backspace', metaKey: true })]
  ])('remembers %s for its release', (_label, event) => {
    expect(isImeExemptTerminalChord({ ...event, isComposing: true })).toBe(true)
  })
})
