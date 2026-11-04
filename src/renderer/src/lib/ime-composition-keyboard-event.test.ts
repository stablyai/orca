// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useImeEnterGestureOwnership } from './ime-composition-keyboard-event'

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

  // Pinyin can emit Process/229 for every key; non-Enter keyup must disarm carry before a later deliberate submit.
  it.each([
    { key: '1', keyCode: 49 },
    { key: 'Process', keyCode: 229 }
  ])(
    'expires the carry after candidate selection keyup %j so deliberate Enter submits',
    (release) => {
      const { result } = renderHook(() => useImeEnterGestureOwnership())
      result.current.setComposing(true)

      // Pinyin candidate selection: the last composing key is a digit reported as Process/229.
      expect(
        result.current.ownsKeyDown(
          gestureEvent({ key: 'Process', keyCode: 229, isComposing: true })
        )
      ).toBe(true)
      result.current.setComposing(false)
      let frame: FrameRequestCallback | undefined
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
        frame = cb
        return 1
      })
      result.current.onKeyUp(gestureEvent(release))
      frame?.(0)
      raf.mockRestore()

      const deliberate = gestureEvent({ key: 'Enter', keyCode: 13 })
      expect(result.current.ownsKeyDown(deliberate)).toBe(false)
      expect(deliberate.prevented).toBe(false)
    }
  )

  it('keeps a newer gesture owned when an older keyup expires', () => {
    const { result } = renderHook(() => useImeEnterGestureOwnership())
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    try {
      const marked = { key: 'Process', keyCode: 229 }
      result.current.ownsKeyDown(gestureEvent(marked))
      result.current.onKeyUp(gestureEvent(marked))
      result.current.ownsKeyDown(gestureEvent(marked))
      frames[0]?.(0)

      const redispatch = gestureEvent({ key: 'Enter', keyCode: 13 })
      expect(result.current.ownsKeyDown(redispatch)).toBe(true)
      expect(redispatch.prevented).toBe(true)
    } finally {
      raf.mockRestore()
    }
  })

  // Only bare confirm redispatch is suppressed; held Cmd/Ctrl still requests deliberate submit.
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

  // Chorded redispatch must spend carry without suppressing submit or the next Enter would be swallowed.
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
