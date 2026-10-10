// @vitest-environment happy-dom
import { useRef } from 'react'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { useNativeChatReaderScrollInput } from './native-chat-reader-scroll-input'
import { useNativeChatTranscriptScroll } from './use-native-chat-transcript-scroll'

function FirstReply({ phase, pin }: { phase: number; pin: () => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const transcript = useNativeChatTranscriptScroll({
    scrollRef,
    contentRef,
    itemCount: phase,
    isWorking: phase > 0,
    showsTailRow: phase > 0,
    isVisible: true,
    alignToViewportTop: vi.fn(),
    isAlignPending: () => false,
    scrollToEnd: pin,
    restoreScrollOffset: vi.fn(),
    consumeProgrammaticScroll: () => false,
    reconcileReaderScroll: vi.fn()
  })
  const input = useNativeChatReaderScrollInput(scrollRef, {
    onReaderScroll: vi.fn(),
    onLeaveEnd: transcript.readerLeavesEnd
  })
  return (
    <div
      {...input.scrollerProps}
      ref={scrollRef}
      onScroll={transcript.onScroll}
      data-testid="scroll"
    >
      <div ref={contentRef}>
        {phase > 0 ? (
          <p>
            First prompt <button>Copy</button>
          </p>
        ) : null}
      </div>
      {transcript.showJump ? <button>Jump to latest</button> : null}
    </div>
  )
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

it.each([
  'empty press',
  'first-row press',
  'first-row hover',
  'hover then passive scroll',
  'passive scroll'
])('follows a first reply past the viewport after %s without a reader scroll', (interaction) => {
  let height = 600
  let element: HTMLElement | null = null
  const pin = vi.fn(() => {
    if (element) {
      element.scrollTop = Math.max(0, height - 600)
    }
  })
  const view = render(<FirstReply phase={0} pin={pin} />)
  element = view.getByTestId('scroll')
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 600 },
    scrollHeight: { configurable: true, get: () => height }
  })
  if (interaction === 'empty press') {
    fireEvent.pointerDown(element)
  }
  view.rerender(<FirstReply phase={1} pin={pin} />)
  if (interaction === 'first-row press') {
    fireEvent.pointerDown(view.getByText(/First prompt/))
  }
  if (interaction === 'first-row hover' || interaction === 'hover then passive scroll') {
    fireEvent.pointerOver(view.getByRole('button', { name: 'Copy' }))
  }
  if (interaction === 'passive scroll' || interaction === 'hover then passive scroll') {
    fireEvent.scroll(element)
  }
  pin.mockClear()
  height = 1600
  view.rerender(<FirstReply phase={2} pin={pin} />)
  expect(pin).toHaveBeenCalled()
  expect(element.scrollTop).toBe(1000)
  expect(view.queryByRole('button', { name: 'Jump to latest' })).toBeNull()
})
