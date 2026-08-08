// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useImeEnterGestureOwnership } from './ime-composition-keyboard-event'

/**
 * The ownership contract for the confirming Enter of a CJK composition. Every case below is
 * load-bearing; two of them describe bugs that were live on the same day, in opposite
 * directions, and both are easy to reintroduce while "simplifying" the consume branch:
 *
 *  - Drop `!hasChordModifier` from the consume branch and a chorded confirm is SWALLOWED —
 *    the user's Ctrl/Cmd+Enter submit silently does nothing.
 *  - Clear the carry only on the bare path and the chorded confirm leaves it ARMED —
 *    the user's next Enter is eaten instead.
 *
 * The carry must be spent on both paths; only a bare Enter is also consumed.
 */

type Chord = { altKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean }
type TestKeyEvent = ReactKeyboardEvent & { prevented: boolean }

function enter(
  opts: { key?: string; keyCode?: number; isComposing?: boolean } & Chord = {}
): TestKeyEvent {
  return {
    key: opts.key ?? 'Enter',
    keyCode: opts.keyCode ?? 13,
    altKey: opts.altKey ?? false,
    ctrlKey: opts.ctrlKey ?? false,
    metaKey: opts.metaKey ?? false,
    shiftKey: opts.shiftKey ?? false,
    nativeEvent: { isComposing: opts.isComposing ?? false },
    prevented: false,
    preventDefault() {
      ;(this as { prevented: boolean }).prevented = true
    }
  } as unknown as TestKeyEvent
}

function ownership() {
  return renderHook(() => useImeEnterGestureOwnership()).result
}

/** Windows/Linux ordering: the IME redispatches the unmarked Enter before any keyup. */
function confirmGesture(result: ReturnType<typeof ownership>, redispatch: TestKeyEvent): boolean {
  result.current.setComposing(true)
  result.current.ownsKeyDown(enter({ key: 'Process', keyCode: 229, isComposing: true }))
  result.current.setComposing(false)
  return result.current.ownsKeyDown(redispatch)
}

const CHORDS: Chord[] = [{ ctrlKey: true }, { altKey: true }, { metaKey: true }]

describe('IME Enter gesture ownership — the four behaviours', () => {
  it('blocks the unmarked Enter redispatched after compositionend', () => {
    const result = ownership()
    const redispatch = enter()
    expect(confirmGesture(result, redispatch)).toBe(true)
    expect(redispatch.prevented).toBe(true)
  })

  it('blocks a chord pressed during composition, so the preedit survives', () => {
    for (const chord of CHORDS) {
      const result = ownership()
      result.current.setComposing(true)
      expect(result.current.ownsKeyDown(enter({ isComposing: true, ...chord }))).toBe(true)
    }
  })

  it('submits when a modifier is held through the confirm', () => {
    for (const chord of CHORDS) {
      const result = ownership()
      const redispatch = enter(chord)
      expect(confirmGesture(result, redispatch)).toBe(false)
      expect(redispatch.prevented).toBe(false)
    }
  })

  it('submits an ordinary Enter with no composition in flight', () => {
    const result = ownership()
    const ordinary = enter()
    expect(result.current.ownsKeyDown(ordinary)).toBe(false)
    expect(ordinary.prevented).toBe(false)
  })
})

describe('IME Enter gesture ownership — the carry is spent on both paths', () => {
  it('does not eat the next Enter after a chorded confirm passed through', () => {
    const result = ownership()
    expect(confirmGesture(result, enter({ ctrlKey: true }))).toBe(false)
    const next = enter()
    expect({ owned: result.current.ownsKeyDown(next), prevented: next.prevented }).toEqual({
      owned: false,
      prevented: false
    })
  })

  it('does not eat the next Enter even within the chord keyup frame', () => {
    const result = ownership()
    expect(confirmGesture(result, enter({ ctrlKey: true }))).toBe(false)
    // The chord's own keyup only schedules the next-frame expiry, so an Enter landing
    // before that frame turns must still reach the app.
    result.current.onKeyUp(enter({ ctrlKey: true }))
    const next = enter()
    expect({ owned: result.current.ownsKeyDown(next), prevented: next.prevented }).toEqual({
      owned: false,
      prevented: false
    })
  })

  it('spends the carry on a bare confirm too, so the following Enter is free', () => {
    const result = ownership()
    expect(confirmGesture(result, enter())).toBe(true)
    expect(result.current.ownsKeyDown(enter())).toBe(false)
  })
})

describe('IME Enter gesture ownership — Shift+Enter is always a newline', () => {
  it('never owns Shift+Enter, composing or on the redispatch', () => {
    const result = ownership()
    result.current.setComposing(true)
    expect(result.current.ownsKeyDown(enter({ isComposing: true, shiftKey: true }))).toBe(false)
    result.current.setComposing(false)
    const redispatch = enter({ shiftKey: true })
    expect(result.current.ownsKeyDown(redispatch)).toBe(false)
    expect(redispatch.prevented).toBe(false)
  })

  it('never owns Shift+Enter even while a real confirm is armed', () => {
    const result = ownership()
    expect(confirmGesture(result, enter({ shiftKey: true }))).toBe(false)
  })
})

describe('IME Enter gesture ownership — expiry timing', () => {
  it('outlives a keyup delivered before the redispatch, as macOS does', () => {
    const result = ownership()
    result.current.setComposing(true)
    result.current.ownsKeyDown(enter({ key: 'Process', keyCode: 229, isComposing: true }))
    result.current.setComposing(false)
    // A synchronous clear here sends the composed text one keystroke early on macOS.
    result.current.onKeyUp(enter())
    const redispatch = enter()
    expect(result.current.ownsKeyDown(redispatch)).toBe(true)
    expect(redispatch.prevented).toBe(true)
  })

  it('expires on the next frame rather than synchronously', async () => {
    const result = ownership()
    result.current.setComposing(true)
    result.current.ownsKeyDown(enter({ key: 'Process', keyCode: 229, isComposing: true }))
    result.current.setComposing(false)
    result.current.onKeyUp(enter())
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(result.current.ownsKeyDown(enter())).toBe(false)
  })

  it('clears immediately on a Process/229 keyup, which means the IME finished', () => {
    const result = ownership()
    result.current.setComposing(true)
    result.current.ownsKeyDown(enter({ key: 'Process', keyCode: 229, isComposing: true }))
    result.current.setComposing(false)
    result.current.onKeyUp(enter({ key: 'Process', keyCode: 229 }))
    expect(result.current.ownsKeyDown(enter())).toBe(false)
  })
})
