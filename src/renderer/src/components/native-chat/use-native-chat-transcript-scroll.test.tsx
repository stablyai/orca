// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

function TranscriptHarness({
  isVisible,
  restoreScrollOffset,
  scrollToEnd,
  reconcileReaderScroll = vi.fn(),
  itemCount = 100
}: {
  isVisible: boolean
  restoreScrollOffset: (offset: number) => void
  scrollToEnd: () => void
  reconcileReaderScroll?: (isTakingOver: boolean) => void
  itemCount?: number
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const transcript = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount,
    isWorking: false,
    showsTailRow: false,
    isVisible,
    alignToViewportTop: vi.fn(),
    isAlignPending: () => false,
    scrollToEnd,
    restoreScrollOffset,
    consumeProgrammaticScroll: () => false,
    reconcileReaderScroll
  })
  const input = useNativeChatReaderScrollInput(scrollRef, {
    onReaderScroll: () => {},
    onLeaveEnd: transcript.readerLeavesEnd
  })
  return (
    <div
      {...input.scrollerProps}
      ref={scrollRef}
      data-testid="scroll"
      onScroll={transcript.onScroll}
    >
      <div ref={contentRef} />
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([0, 250, 251])(
  'rebases a pending reader target after %i ms until its frame ends',
  (elapsed) => {
    let clock = 1000
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const frames = new Map<number, FrameRequestCallback>()
    let nextFrame = 0
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      const id = ++nextFrame
      frames.set(id, callback)
      return id
    })
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => frames.delete(id))
    let element: HTMLElement | null = null
    let pendingFrame: number | null = null
    let retainedTarget = 8204
    const rebase = vi.fn((offset: number) => {
      retainedTarget = offset
    })
    // The window adapter replaces targets only on takeover or while its frame is pending.
    const reconcileReaderScroll = vi.fn((isTakingOver: boolean) => {
      if (!element || (!isTakingOver && pendingFrame === null)) {
        return
      }
      rebase(element.scrollTop)
      if (pendingFrame === null) {
        pendingFrame = window.requestAnimationFrame(() => {
          pendingFrame = null
        })
      }
    })
    const view = render(
      <TranscriptHarness
        isVisible
        restoreScrollOffset={vi.fn()}
        scrollToEnd={vi.fn()}
        reconcileReaderScroll={reconcileReaderScroll}
      />
    )
    element = view.getByTestId('scroll')
    Object.defineProperties(element, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 8804 }
    })
    element.scrollTop = 8204
    fireEvent.scroll(element)
    expect(rebase).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)

    fireEvent.wheel(element, { deltaY: -100 })
    expect(rebase.mock.calls).toEqual([[8204]])
    expect(frames.size).toBe(1)
    clock += elapsed
    element.scrollTop = 2000
    fireEvent.scroll(element)
    expect(retainedTarget).toBe(2000)
    expect(rebase.mock.calls).toEqual([[8204], [2000]])
    expect(frames.size).toBe(1)

    for (const [id, callback] of frames) {
      frames.delete(id)
      callback(clock)
    }
    expect(pendingFrame).toBeNull()
    element.scrollTop = 1800
    fireEvent.scroll(element)
    fireEvent.scroll(element)
    expect(reconcileReaderScroll).toHaveBeenLastCalledWith(false)
    expect(retainedTarget).toBe(2000)
    expect(rebase.mock.calls).toEqual([[8204], [2000]])
    expect(frames.size).toBe(0)
  }
)

describe('native chat transcript visibility', () => {
  it('restores the last detached offset when a retained tab is revealed', () => {
    let scrollTop = 900
    const scrollToEnd = vi.fn()
    let scrollElement: HTMLElement | null = null
    const restoreScrollOffset = vi.fn((offset: number) => {
      scrollTop = offset
    })
    const view = render(
      <TranscriptHarness
        isVisible
        restoreScrollOffset={restoreScrollOffset}
        scrollToEnd={scrollToEnd}
      />
    )
    scrollElement = view.getByTestId('scroll')
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => 1_000 },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        }
      }
    })

    fireEvent.wheel(scrollElement, { deltaY: -100 })
    scrollTop = 320
    fireEvent.scroll(scrollElement)
    view.rerender(
      <TranscriptHarness
        isVisible={false}
        restoreScrollOffset={restoreScrollOffset}
        scrollToEnd={scrollToEnd}
      />
    )

    // A reveal-time geometry reconciliation can drift the retained DOM to its end.
    scrollTop = 900
    fireEvent.scroll(scrollElement)
    view.rerender(
      <TranscriptHarness
        isVisible
        restoreScrollOffset={restoreScrollOffset}
        scrollToEnd={scrollToEnd}
      />
    )

    expect(restoreScrollOffset).toHaveBeenCalledExactlyOnceWith(320)
    expect(scrollTop).toBe(320)
  })
})

describe('native chat transcript follow', () => {
  // Folding a settled turn shrinks the content, and the browser clamps a reader
  // parked just above the end onto it. That offset moves up, but toward the end.
  it('reattaches a detached reader that content shrinking clamps onto the end', () => {
    let scrollTop = 900
    let scrollHeight = 1_000
    const scrollToEnd = vi.fn()
    const props = { isVisible: true, restoreScrollOffset: vi.fn(), scrollToEnd }
    const view = render(<TranscriptHarness {...props} />)
    const scrollElement = view.getByTestId('scroll')
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = value
        }
      }
    })

    fireEvent.wheel(scrollElement, { deltaY: -50 })
    scrollTop = 850
    fireEvent.scroll(scrollElement)
    scrollToEnd.mockClear()
    view.rerender(<TranscriptHarness {...props} itemCount={101} />)
    // Anti-vacuous: detached 50px up, new content does not pull the reader down.
    expect(scrollToEnd).not.toHaveBeenCalled()

    scrollHeight = 700
    scrollTop = 600
    fireEvent.scroll(scrollElement)
    view.rerender(<TranscriptHarness {...props} itemCount={102} />)

    expect(scrollToEnd).toHaveBeenCalled()
  })

  // A shrink clamps the offset; its scroll event can land after more output has grown the end.
  it('keeps following when content shrinks under a reader at the end', () => {
    let scrollTop = 900
    let scrollHeight = 1_000
    const scrollToEnd = vi.fn()
    const props = { isVisible: true, restoreScrollOffset: vi.fn(), scrollToEnd }
    const view = render(<TranscriptHarness {...props} />)
    const scrollElement = view.getByTestId('scroll')
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: { configurable: true, get: () => scrollTop, set: (value) => (scrollTop = value) }
    })

    scrollHeight = 700
    scrollTop = 600
    scrollHeight = 900
    fireEvent.scroll(scrollElement)
    scrollToEnd.mockClear()
    view.rerender(<TranscriptHarness {...props} itemCount={101} />)

    expect(scrollToEnd).toHaveBeenCalled()
  })
})
