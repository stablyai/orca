// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

function TranscriptHarness({
  isVisible,
  restoreScrollOffset,
  scrollToEnd,
  itemCount = 100
}: {
  isVisible: boolean
  restoreScrollOffset: (offset: number) => void
  scrollToEnd: () => void
  itemCount?: number
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const transcript = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount,
    isWorking: false,
    showTypingIndicator: false,
    isVisible,
    alignToViewportTop: vi.fn(),
    scrollToEnd,
    restoreScrollOffset,
    consumeProgrammaticScroll: () => false,
    reconcileReaderScroll: vi.fn()
  })
  return (
    <div ref={scrollRef} data-testid="scroll" onScroll={transcript.onScroll}>
      <div ref={contentRef} />
    </div>
  )
}

afterEach(cleanup)

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
})
