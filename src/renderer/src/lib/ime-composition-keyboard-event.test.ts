// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import {
  isImeCompositionKeyDown,
  isImeOwnedKeyboardEvent,
  resolveImeModifierGesture,
  useImeEnterGestureOwnership
} from './ime-composition-keyboard-event'

type ImeEnterGestureEventForTest = Pick<
  ReactKeyboardEvent,
  | 'altKey'
  | 'ctrlKey'
  | 'key'
  | 'keyCode'
  | 'metaKey'
  | 'nativeEvent'
  | 'preventDefault'
  | 'shiftKey'
> & { readonly prevented: boolean }

function keyEvent(nativeEvent: { isComposing?: boolean; keyCode?: number }): ReactKeyboardEvent {
  return {
    nativeEvent: {
      isComposing: nativeEvent.isComposing ?? false,
      keyCode: nativeEvent.keyCode ?? 13
    }
  } as unknown as ReactKeyboardEvent
}

describe('isImeCompositionKeyDown', () => {
  it('owns the marked real Enter shape without treating plain Enter as IME input', () => {
    expect(isImeOwnedKeyboardEvent({ isComposing: true, keyCode: 13 })).toBe(true)
    expect(isImeOwnedKeyboardEvent({ isComposing: false, keyCode: 13 })).toBe(false)
  })

  it('is true while the IME is composing', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: true }))).toBe(true)
  })

  it('is true for the keyCode 229 fallback when isComposing is not set', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 229 }))).toBe(true)
  })

  it('is false for a plain Enter outside of composition', () => {
    expect(isImeCompositionKeyDown(keyEvent({ isComposing: false, keyCode: 13 }))).toBe(false)
  })

  it('keeps the recorded Process/ShiftLeft event IME-owned without treating ordinary Shift as IME', () => {
    const shift = { code: 'ShiftLeft', shiftKey: true, isComposing: false }
    expect(isImeOwnedKeyboardEvent({ ...shift, key: 'Process', keyCode: 229 })).toBe(true)
    expect(isImeOwnedKeyboardEvent({ ...shift, key: 'Shift', keyCode: 16 })).toBe(false)
  })

  it('owns the marked Windows palette chord without swallowing the ordinary chord', () => {
    const chord = { key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true, keyCode: 74 }
    expect(isImeOwnedKeyboardEvent({ ...chord, isComposing: true })).toBe(true)
    expect(isImeOwnedKeyboardEvent({ ...chord, isComposing: false })).toBe(false)
  })

  it('keeps ownership through the recorded marked modifiers and unmarked dispatch key', () => {
    let gesture = resolveImeModifierGesture(false, {
      ctrlKey: true,
      isComposing: true
    })
    expect(gesture).toEqual({ active: true, carried: false, owned: true })

    gesture = resolveImeModifierGesture(gesture.active, {
      ctrlKey: true,
      shiftKey: true,
      isComposing: true
    })
    gesture = resolveImeModifierGesture(gesture.active, {
      ctrlKey: true,
      shiftKey: true,
      isComposing: false
    })
    expect(gesture).toEqual({ active: true, carried: true, owned: true })

    gesture = resolveImeModifierGesture(gesture.active, {
      isComposing: false
    })
    expect(gesture).toEqual({ active: false, carried: true, owned: true })
    expect(
      resolveImeModifierGesture(false, {
        ctrlKey: true,
        shiftKey: true,
        isComposing: false
      })
    ).toEqual({ active: false, carried: false, owned: false })
  })
})

describe('useImeEnterGestureOwnership', () => {
  function gestureEvent(init: {
    key: string
    keyCode: number
    altKey?: boolean
    ctrlKey?: boolean
    isComposing?: boolean
    metaKey?: boolean
    shiftKey?: boolean
  }): ImeEnterGestureEventForTest {
    let prevented = false
    return {
      key: init.key,
      keyCode: init.keyCode,
      altKey: init.altKey ?? false,
      ctrlKey: init.ctrlKey ?? false,
      metaKey: init.metaKey ?? false,
      shiftKey: init.shiftKey ?? false,
      nativeEvent: { isComposing: init.isComposing ?? false } as KeyboardEvent,
      preventDefault: () => {
        prevented = true
      },
      get prevented() {
        return prevented
      }
    }
  }

  // Regression: Shift+Enter is a newline, never a submit. Owning it swallowed the
  // newline in multi-line comment boxes after a composition (DiffCommentPopover).
  it('never owns Shift+Enter, during composition or on the redispatch', () => {
    const { result } = renderHook(() => useImeEnterGestureOwnership())
    result.current.setComposing(true)

    const marked = gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true, shiftKey: true })
    expect(result.current.ownsKeyDown(marked)).toBe(false)

    result.current.setComposing(false)
    const redispatch = gestureEvent({ key: 'Enter', keyCode: 13, shiftKey: true })
    expect(result.current.ownsKeyDown(redispatch)).toBe(false)
    expect(redispatch.prevented).toBe(false)
  })

  // Regression: IMEs that report Process/229 for EVERY key (Pinyin) armed the carry on
  // each letter. A non-Enter keyup must disarm it, or a later deliberate Enter is eaten.
  it('expires the carry a frame after a non-Enter keyup so a later deliberate Enter submits', () => {
    const { result } = renderHook(() => useImeEnterGestureOwnership())
    result.current.setComposing(true)

    // Pinyin candidate selection: the last composing key is a digit reported as Process/229.
    expect(
      result.current.ownsKeyDown(gestureEvent({ key: 'Process', keyCode: 229, isComposing: true }))
    ).toBe(true)
    result.current.setComposing(false)
    let frame: FrameRequestCallback | undefined
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frame = cb
      return 1
    })
    result.current.onKeyUp(gestureEvent({ key: '1', keyCode: 49 }))
    frame?.(0)
    raf.mockRestore()

    const deliberate = gestureEvent({ key: 'Enter', keyCode: 13 })
    expect(result.current.ownsKeyDown(deliberate)).toBe(false)
    expect(deliberate.prevented).toBe(false)
  })

  // Regression: holding Cmd/Ctrl through a composition confirm dropped the chord submit —
  // the carry stands in for the bare redispatch only, never for a deliberate chord.
  it.each([
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['alt', { altKey: true }]
  ])('lets the %s+Enter chord through the carried redispatch', (_label, modifier) => {
    const { result } = renderHook(() => useImeEnterGestureOwnership())
    result.current.setComposing(true)

    // The IME still owns the confirming keydown even with the modifier held.
    expect(
      result.current.ownsKeyDown(
        gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true, ...modifier })
      )
    ).toBe(true)

    result.current.setComposing(false)
    const chord = gestureEvent({ key: 'Enter', keyCode: 13, ...modifier })
    expect(result.current.ownsKeyDown(chord)).toBe(false)
    expect(chord.prevented).toBe(false)
  })

  // Regression: the chorded redispatch fell through without spending the carry, so the
  // next Enter in the same frame was swallowed — the mirror of the bug above.
  it('spends the carry on the chorded redispatch so the next Enter is not eaten', () => {
    const { result } = renderHook(() => useImeEnterGestureOwnership())
    result.current.setComposing(true)
    result.current.ownsKeyDown(
      gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true, ctrlKey: true })
    )
    result.current.setComposing(false)

    const chord = gestureEvent({ key: 'Enter', keyCode: 13, ctrlKey: true })
    expect(result.current.ownsKeyDown(chord)).toBe(false)

    // The chord's own keyup only schedules the expiry; the frame has not elapsed yet.
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1)
    result.current.onKeyUp(gestureEvent({ key: 'Enter', keyCode: 13, ctrlKey: true }))
    raf.mockRestore()

    const next = gestureEvent({ key: 'Enter', keyCode: 13 })
    expect(result.current.ownsKeyDown(next)).toBe(false)
    expect(next.prevented).toBe(false)
  })

  // Guard for the above: the bare redispatch (Mode B) must still be swallowed.
  it('still swallows the unmodified redispatch armed by a chorded confirm', () => {
    const { result } = renderHook(() => useImeEnterGestureOwnership())
    result.current.setComposing(true)
    result.current.ownsKeyDown(
      gestureEvent({ key: 'Enter', keyCode: 13, isComposing: true, metaKey: true })
    )

    result.current.setComposing(false)
    const redispatch = gestureEvent({ key: 'Enter', keyCode: 13 })
    expect(result.current.ownsKeyDown(redispatch)).toBe(true)
    expect(redispatch.prevented).toBe(true)
  })
})
