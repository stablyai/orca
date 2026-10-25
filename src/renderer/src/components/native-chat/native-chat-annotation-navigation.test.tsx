// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatMessageList } from './NativeChatMessageList'
import type { NativeChatMessageListHandle } from './use-native-chat-reveal-latest'
import { useNativeChatAnnotationLocate } from './use-native-chat-annotation-locate'
import {
  deliverResizes,
  marker,
  session,
  stubLayout,
  stubResizeObserver
} from './native-chat-windowing-test-harness'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

it('remounts an old annotated message through the virtual list and detaches from the live tail', () => {
  vi.useFakeTimers()
  const undo = [stubLayout({ scrollGeometry: true, offsetChain: true }), stubResizeObserver()]
  try {
    const handle = createRef<NativeChatMessageListHandle>()
    const messages = Array.from({ length: 200 }, (_, index) => marker(index))
    const { container, rerender } = render(
      <NativeChatMessageList
        ref={handle}
        session={session(messages)}
        isWorking
        expandSignal={false}
      />
    )
    const paint = (): void => {
      const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
      for (let i = 0; i < 12; i += 1) {
        act(() => {
          deliverResizes()
          vi.advanceTimersByTime(16)
        })
        if (scroller) {
          fireEvent.scroll(scroller)
        }
      }
    }
    paint()
    expect(screen.queryByText('marker-1')).toBeNull()
    act(() => {
      expect(handle.current?.revealAnnotationMessage?.('message-1')).toBe(true)
    })
    paint()
    expect(screen.getByText('marker-1')).toBeTruthy()
    const scroller = container.querySelector<HTMLElement>('[data-native-chat-scroll]')
    const top = scroller?.scrollTop
    rerender(
      <NativeChatMessageList
        ref={handle}
        session={session([...messages, marker(200)])}
        isWorking
        expandSignal={false}
      />
    )
    paint()
    expect(scroller?.scrollTop).toBe(top)
    act(() => {
      expect(handle.current?.revealAnnotationMessage?.('unknown')).toBe(false)
    })
  } finally {
    cleanup()
    for (const restore of undo.toReversed()) {
      restore()
    }
  }
})

it('waits for the requested message to mount and respects reduced motion', async () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('reduce'),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => true
  }))
  const reveal = vi.fn(() => true)
  function Harness() {
    const rootRef = useRef<HTMLDivElement>(null)
    const { locate, missingOriginal } = useNativeChatAnnotationLocate(rootRef, 'navigation', true, {
      current: { revealAnnotationMessage: reveal }
    })
    return (
      <div ref={rootRef}>
        <button onClick={() => locate({ messageId: 'old', quote: 'Old words.', startOffset: 0 })}>
          Locate
        </button>
        {missingOriginal ? 'Missing' : null}
      </div>
    )
  }
  const { container } = render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Locate' }))
  expect(reveal).toHaveBeenCalledWith('old')
  await act(async () => {
    const row = document.createElement('div')
    row.setAttribute('data-native-chat-message-id', 'old')
    const source = document.createElement('p')
    source.setAttribute('data-native-chat-quote-source', '')
    source.textContent = 'Old words.'
    row.append(source)
    container.firstElementChild?.append(row)
    await Promise.resolve()
  })
  expect(scroll).toHaveBeenCalledWith({ block: 'center', behavior: 'auto' })
  expect(screen.queryByText('Missing')).toBeNull()
})

it('locates a mounted passage even when it is absent from the navigable slots', () => {
  const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {})
  const reveal = vi.fn(() => false)
  function Harness() {
    const rootRef = useRef<HTMLDivElement>(null)
    const { locate, missingOriginal } = useNativeChatAnnotationLocate(rootRef, 'nested', true, {
      current: { revealAnnotationMessage: reveal }
    })
    return (
      <div ref={rootRef}>
        <div data-native-chat-message-id="nested-reply">
          <p data-native-chat-quote-source="">Visible subagent reply.</p>
        </div>
        <button
          onClick={() =>
            locate({ messageId: 'nested-reply', quote: 'Visible subagent reply.', startOffset: 0 })
          }
        >
          Locate
        </button>
        {missingOriginal ? 'Missing' : null}
      </div>
    )
  }
  render(<Harness />)
  fireEvent.click(screen.getByRole('button', { name: 'Locate' }))
  expect(scroll).toHaveBeenCalled()
  expect(screen.queryByText('Missing')).toBeNull()
})
