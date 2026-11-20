// @vitest-environment happy-dom

// The gap between a run's slots is measured in Chromium (tests/component-fixtures/native-chat-note-run.spec.ts).
import { renderHook } from '@testing-library/react'
import { Virtualizer, elementScroll, observeElementOffset } from '@tanstack/react-virtual'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createProgrammaticScrollMarks } from '@/lib/list-interaction/virtualized-scrolling/programmatic-scroll-marks'
import {
  nativeChatRowDrawnAbove,
  useNativeChatViewportAlign
} from './use-native-chat-viewport-align'

function row(wrapperTop: number, contentTop: number): HTMLElement {
  const wrapper = document.createElement('div')
  const content = document.createElement('div')
  wrapper.append(content)
  wrapper.getBoundingClientRect = () => new DOMRect(0, wrapperTop, 100, 40)
  content.getBoundingClientRect = () => new DOMRect(0, contentTop, 100, 56)
  return wrapper
}

describe('where a jump lands a row', () => {
  it('lands every other row by its own top', () => {
    expect(nativeChatRowDrawnAbove(row(200, 200))).toBe(0)
    expect(nativeChatRowDrawnAbove(document.createElement('div'))).toBe(0)
  })
})

describe('a jump to a row drawn above its own top', () => {
  const ROW_PX = 50
  const VIEWPORT_PX = 400

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['requestAnimationFrame', 'cancelAnimationFrame', 'performance']
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A scroll container without layout: scroll writes land as given, within the virtual size. */
  function scroller(): {
    container: HTMLDivElement
    virtualizer: Virtualizer<HTMLDivElement, Element>
  } {
    const container = document.createElement('div')
    let top = 0
    const virtualizer = new Virtualizer<HTMLDivElement, Element>({
      count: 40,
      getScrollElement: () => container,
      estimateSize: () => ROW_PX,
      scrollToFn: elementScroll,
      observeElementRect: (_instance, cb) => {
        cb({ width: 600, height: VIEWPORT_PX })
        return () => {}
      },
      observeElementOffset,
      // `useVirtualizer` re-renders on change, and rendering reads the rows' new layout.
      onChange: (instance) => {
        instance.getVirtualItems()
      },
      initialRect: { width: 600, height: VIEWPORT_PX }
    })
    Object.defineProperties(container, {
      clientHeight: { get: () => VIEWPORT_PX },
      scrollHeight: { get: () => virtualizer.getTotalSize() },
      scrollTop: {
        get: () => top,
        set: (value: number) => {
          top = value
        }
      }
    })
    Object.defineProperty(container, 'scrollTo', {
      value: (options: ScrollToOptions) => {
        top = Math.max(0, Math.min(options.top ?? top, virtualizer.getTotalSize() - VIEWPORT_PX))
        container.dispatchEvent(new Event('scroll'))
      }
    })
    virtualizer._didMount()
    virtualizer._willUpdate()
    return { container, virtualizer }
  }

  it('keeps its first note at the top when a row above it is measured before the jump settles', () => {
    const { container, virtualizer } = scroller()
    // Like the window when the reader moved the scroll unseen: no compensation for rows above.
    virtualizer.shouldAdjustScrollPositionOnItemSizeChange = () => false
    const { result } = renderHook(() =>
      useNativeChatViewportAlign({
        scrollRef: { current: container },
        virtualizer,
        finishReaderTakeover: () => {},
        programmaticScrollMarks: createProgrammaticScrollMarks(),
        holdJumpDrawnAbove: () => {}
      })
    )
    // Row 20 where the window draws it in the unscrolled container, its first note 16 px higher.
    const target = row(20 * ROW_PX, 20 * ROW_PX - 16)
    target.dataset.index = '20'

    result.current.alignToViewportTop(target)
    expect(container.scrollTop).toBe(20 * ROW_PX - 16)

    virtualizer.resizeItem(5, ROW_PX + 40)
    vi.advanceTimersToNextFrame()

    expect(container.scrollTop).toBe(20 * ROW_PX + 40 - 16)
  })
})
