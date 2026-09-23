// @vitest-environment happy-dom

import { useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

function TranscriptHarness({
  isVisible,
  restoreScrollOffset,
  scrollToEnd
}: {
  isVisible: boolean
  restoreScrollOffset: (offset: number) => void
  scrollToEnd: () => void
}): React.JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const transcript = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount: 100,
    isWorking: false,
    showAgentStateRow: false,
    isVisible,
    hasMore: false,
    loadingEarlier: false,
    loadEarlier: vi.fn(),
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
