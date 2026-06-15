import { describe, expect, it } from 'vitest'
import {
  ModifierDoubleTapDetector,
  modifierFromKeyEvent,
  toModifierDoubleTapEvent,
  type ModifierDoubleTapEvent
} from './modifier-double-tap-detector'

function down(
  modifier: ModifierDoubleTapEvent['modifier'],
  overrides: Partial<ModifierDoubleTapEvent> = {}
): ModifierDoubleTapEvent {
  return { type: 'keyDown', modifier, isModifierOnly: true, isAutoRepeat: false, ...overrides }
}

function up(
  modifier: ModifierDoubleTapEvent['modifier'],
  overrides: Partial<ModifierDoubleTapEvent> = {}
): ModifierDoubleTapEvent {
  return { type: 'keyUp', modifier, isModifierOnly: true, isAutoRepeat: false, ...overrides }
}

const otherKey: ModifierDoubleTapEvent = {
  type: 'keyDown',
  modifier: null,
  isModifierOnly: false,
  isAutoRepeat: false
}

describe('ModifierDoubleTapDetector', () => {
  it('emits when the second press lands inside the window', () => {
    const d = new ModifierDoubleTapDetector()
    expect(d.process(down('Shift'), 0)).toBeNull()
    expect(d.process(up('Shift'), 10)).toBeNull()
    expect(d.process(down('Shift'), 200)).toEqual({ modifier: 'Shift' })
  })

  it('does not emit when the second press is past the window', () => {
    const d = new ModifierDoubleTapDetector()
    d.process(down('Shift'), 0)
    d.process(up('Shift'), 10)
    expect(d.process(down('Shift'), 400)).toBeNull()
  })

  it('resets on an intervening non-modifier key', () => {
    const d = new ModifierDoubleTapDetector()
    d.process(down('Shift'), 0)
    d.process(up('Shift'), 10)
    expect(d.process(otherKey, 20)).toBeNull()
    expect(d.process(down('Shift'), 100)).toBeNull()
  })

  it('treats a different modifier as a fresh gesture, not a completion', () => {
    const d = new ModifierDoubleTapDetector()
    d.process(down('Shift'), 0)
    d.process(up('Shift'), 10)
    // Wrong modifier: no emit, but it begins a new first tap.
    expect(d.process(down('Alt'), 100)).toBeNull()
    expect(d.process(up('Alt'), 110)).toBeNull()
    expect(d.process(down('Alt'), 150)).toEqual({ modifier: 'Alt' })
  })

  it('does not treat an auto-repeat hold as a tap', () => {
    const d = new ModifierDoubleTapDetector()
    d.process(down('Shift'), 0)
    // Holding the key emits auto-repeat keyDowns — this must cancel the gesture.
    expect(d.process(down('Shift', { isAutoRepeat: true }), 30)).toBeNull()
    d.process(up('Shift'), 500)
    expect(d.process(down('Shift'), 520)).toBeNull()
  })

  it('does not emit when another modifier is held (isModifierOnly false)', () => {
    const d = new ModifierDoubleTapDetector()
    expect(d.process(down('Shift', { isModifierOnly: false }), 0)).toBeNull()
    d.process(up('Shift'), 10)
    expect(d.process(down('Shift'), 100)).toBeNull()
  })

  it('handles a second keyDown of the same modifier without an intervening keyUp', () => {
    const d = new ModifierDoubleTapDetector()
    d.process(down('Shift'), 0)
    // Missed keyUp — a fresh (non-repeat) keyDown for the same modifier just
    // restarts the first tap rather than emitting.
    d.process(down('Shift'), 50)
    d.process(up('Shift'), 60)
    // The next press within the window still completes the gesture.
    expect(d.process(down('Shift'), 200)).toEqual({ modifier: 'Shift' })
  })

  it('clears armed state when the second keydown was suppressed (allowlisted path)', () => {
    const d = new ModifierDoubleTapDetector()
    d.process(down('Shift'), 0) // first tap down → down1
    d.process(up('Shift'), 10) // first tap up → armed
    // The main process suppressed the second keydown (an allowlisted action fired
    // there), but the second tap's keyup still reaches this detector.
    d.process(up('Shift'), 20)
    // A later lone Shift press (e.g. typing a capital) must NOT phantom-complete
    // a double-tap from the stale armed state.
    expect(d.process(down('Shift'), 200)).toBeNull()
  })

  it('clears state on reset()', () => {
    const d = new ModifierDoubleTapDetector()
    d.process(down('Shift'), 0)
    d.process(up('Shift'), 10)
    d.reset()
    expect(d.process(down('Shift'), 100)).toBeNull()
  })

  it('normalizes platform key events', () => {
    expect(modifierFromKeyEvent('ShiftLeft', 'Shift')).toBe('Shift')
    expect(modifierFromKeyEvent('MetaRight', 'Meta')).toBe('Cmd')
    expect(modifierFromKeyEvent('ControlLeft', 'Control')).toBe('Ctrl')
    expect(modifierFromKeyEvent('KeyA', 'a')).toBeNull()

    expect(
      toModifierDoubleTapEvent({ type: 'keyDown', code: 'ShiftLeft', key: 'Shift', shift: true })
    ).toEqual({ type: 'keyDown', modifier: 'Shift', isModifierOnly: true, isAutoRepeat: false })

    // Another modifier held → not a bare modifier event.
    expect(
      toModifierDoubleTapEvent({
        type: 'keyDown',
        code: 'ShiftLeft',
        key: 'Shift',
        shift: true,
        meta: true
      })
    ).toMatchObject({ modifier: 'Shift', isModifierOnly: false })

    expect(
      toModifierDoubleTapEvent({ type: 'keyDown', code: 'KeyA', key: 'a' })
    ).toMatchObject({ modifier: null, isModifierOnly: false })
  })
})
