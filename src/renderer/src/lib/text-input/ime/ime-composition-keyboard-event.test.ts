// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useImeEnterGestureOwnership } from './ime-composition-keyboard-event'

type ImeEnterGestureEventForTest = Pick<
  ReactKeyboardEvent,
  | 'altKey'
  | 'code'
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
    code?: string
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
      code: init.code ?? '',
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
  it('expires the carry after candidate selection keyup so deliberate Enter submits', () => {
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
    result.current.onKeyUp(gestureEvent({ key: 'Process', keyCode: 229 }))
    frame?.(0)
    raf.mockRestore()

    const deliberate = gestureEvent({ key: 'Enter', keyCode: 13 })
    expect(result.current.ownsKeyDown(deliberate)).toBe(false)
    expect(deliberate.prevented).toBe(false)
  })

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

  it('expires a carry from an unknown-code commit key outside a composition', () => {
    const frames: FrameRequestCallback[] = []
    const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frames.push(callback)
      return frames.length
    })
    try {
      const { result } = renderHook(() => useImeEnterGestureOwnership())
      expect(result.current.ownsKeyDown(gestureEvent({ key: 'Process', keyCode: 229 }))).toBe(true)
      for (const frame of frames.splice(0)) {
        frame(0)
      }

      const enter = gestureEvent({ key: 'Enter', keyCode: 13, code: 'Enter' })
      expect(result.current.ownsKeyDown(enter)).toBe(false)
      expect(enter.prevented).toBe(false)
    } finally {
      raf.mockRestore()
    }
  })

  // Commit keys with no keyup expire a frame after compositionend; a held confirm Enter waits for its keyup.
  it.each([
    {
      name: 'expires a Pinyin commit key that reports no code and no keyup',
      commitKey: { key: 'Process', keyCode: 229, code: '' },
      committed: '你好',
      frameRuns: true,
      swallowed: false
    },
    {
      name: 'expires that carry where the chat composer ends composition with setComposing',
      commitKey: { key: 'Process', keyCode: 229, code: '' },
      committed: '你好',
      endsWithSetComposing: true,
      frameRuns: true,
      swallowed: false
    },
    {
      name: 'expires a Hankaku/Zenkaku commit that never sends its keyup (#39289)',
      commitKey: { key: 'Process', keyCode: 229, code: 'Backquote' },
      committed: 'にほんご',
      frameRuns: true,
      swallowed: false
    },
    {
      name: 'swallows the bare Enter that echoes a confirm Enter held across a frame',
      commitKey: { key: 'Enter', keyCode: 229, code: 'Enter' },
      committed: '日本語',
      frameRuns: true,
      keyUpAfterFrame: true,
      swallowed: true
    },
    {
      name: 'swallows the IBus confirm Enter that follows compositionend',
      commitKey: null,
      committed: '日本語',
      frameRuns: false,
      swallowed: true
    }
  ])(
    '$name',
    ({ commitKey, committed, endsWithSetComposing, frameRuns, keyUpAfterFrame, swallowed }) => {
      const frames: FrameRequestCallback[] = []
      const raf = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frames.push(callback)
        return frames.length
      })
      try {
        const { result } = renderHook(() => useImeEnterGestureOwnership())
        result.current.setComposing(true)
        if (commitKey) {
          result.current.ownsKeyDown(gestureEvent({ ...commitKey, isComposing: true }))
        }
        if (endsWithSetComposing) {
          result.current.setComposing(false, committed)
        } else {
          result.current.onCompositionEnd(committed)
        }
        if (frameRuns) {
          for (const frame of frames.splice(0)) {
            frame(0)
          }
        }
        if (keyUpAfterFrame) {
          result.current.onKeyUp(gestureEvent({ key: 'Enter', keyCode: 13, code: 'Enter' }))
        }

        const enter = gestureEvent({ key: 'Enter', keyCode: 13, code: 'Enter' })
        expect(result.current.ownsKeyDown(enter)).toBe(swallowed)
        expect(enter.prevented).toBe(swallowed)
      } finally {
        raf.mockRestore()
      }
    }
  )
})
