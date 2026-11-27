// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { fireEvent, createEvent } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatRailItem } from './native-chat-message-rail-items'
import { NativeChatPinnedPrompt } from './NativeChatPinnedPrompt'

const prompt = (id: string, text = id): NativeChatRailItem => ({
  id,
  slotIndex: 0,
  text,
  hasImages: false,
  timestamp: null
})

describe('NativeChatPinnedPrompt', () => {
  let container: HTMLDivElement
  let root: Root
  let scroller: HTMLDivElement

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    scroller = document.createElement('div')
    Object.defineProperty(scroller, 'clientHeight', { value: 400 })
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  const render = (onReaderScroll = vi.fn()) => {
    scroller.scrollTop = 0
    act(() =>
      root.render(
        <NativeChatPinnedPrompt
          activeId="a"
          items={[prompt('a'), prompt('b')]}
          readerAtEnd={false}
          onJump={() => {}}
          scrollRef={{ current: scroller }}
          onReaderScroll={onReaderScroll}
        />
      )
    )
    return onReaderScroll
  }

  it('forwards a wheel gesture over the header to the transcript scroller', () => {
    const onReaderScroll = render()
    const header = container.querySelector('[data-native-chat-pinned-prompt]')!.closest('div')!
    fireEvent.wheel(header, { deltaY: 40 })
    expect(scroller.scrollTop).toBe(40)
    expect(onReaderScroll).toHaveBeenCalledWith(40)
  })

  it('reports the gesture while the transcript is still where the gesture started', () => {
    // The rail declares the reader left the end by reading scrollTop, so the report has to arrive
    // before this handler moves the transcript.
    const onReaderScroll = render()
    scroller.scrollTop = 12
    const seen: number[] = []
    onReaderScroll.mockImplementation(() => seen.push(scroller.scrollTop))
    const header = container.querySelector('[data-native-chat-pinned-prompt]')!.closest('div')!
    fireEvent.wheel(header, { deltaY: -40 })
    expect(seen).toEqual([12])
  })

  it('leaves a pinch-zoom over the header alone', () => {
    const onReaderScroll = render()
    const header = container.querySelector('[data-native-chat-pinned-prompt]')!.closest('div')!
    const pinch = createEvent.wheel(header, { deltaY: 40 })
    Object.defineProperty(pinch, 'ctrlKey', { value: true })
    act(() => header.dispatchEvent(pinch))
    expect(scroller.scrollTop).toBe(0)
    expect(onReaderScroll).not.toHaveBeenCalled()
  })
})
