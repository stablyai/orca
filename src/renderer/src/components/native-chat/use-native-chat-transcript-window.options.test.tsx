// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatTranscriptSlot } from './native-chat-transcript-slots'

type VirtualizerOptionsCapture = {
  current:
    | ({ count: number; getItemKey: (index: number) => VirtualItem['key'] } & Record<
        string,
        unknown
      >)
    | null
}

const virtualizerMock = vi.hoisted(() => ({
  options: { current: null } as VirtualizerOptionsCapture,
  getTotalSize: vi.fn(() => 0),
  getVirtualItems: vi.fn(() => []),
  measureElement: vi.fn(),
  measure: vi.fn(),
  resizeItem: vi.fn(),
  scrollToOffset: vi.fn(),
  takeSnapshot: vi.fn<() => VirtualItem[]>(() => [])
}))

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: VirtualizerOptionsCapture['current']) => {
    virtualizerMock.options.current = options
    return { ...virtualizerMock, scrollElement: null }
  }
}))

const { MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS, useNativeChatTranscriptWindow } =
  await import('./use-native-chat-transcript-window')

function slot(id: string): NativeChatTranscriptSlot {
  return {
    message: {
      id,
      role: 'assistant',
      blocks: [{ type: 'text', text: id }],
      timestamp: 1,
      source: 'transcript'
    },
    turnKey: undefined,
    activeTurnIsWorking: false,
    receipt: undefined,
    status: undefined,
    turnDiff: undefined,
    estimatedHeight: 48
  }
}

afterEach(() => {
  cleanup()
  virtualizerMock.options.current = null
  vi.clearAllMocks()
})

describe('native chat transcript virtualizer contract', () => {
  it('configures prepend anchoring and matching bottom-follow behavior', () => {
    renderHook(() =>
      useNativeChatTranscriptWindow({
        scrollRef: { current: null },
        slots: [],
        revealIndex: -1
      })
    )

    expect(virtualizerMock.options.current).toMatchObject({
      anchorTo: 'end',
      followOnAppend: true,
      scrollEndThreshold: 48
    })
  })

  it('periodically resets retired measurements while restoring live measured sizes', () => {
    const scrollElement = document.createElement('div')
    scrollElement.scrollTop = 320
    virtualizerMock.takeSnapshot.mockImplementation(() => {
      const key = virtualizerMock.options.current?.getItemKey(0) ?? 'message-0'
      return [{ index: 0, key, start: 0, size: 96, end: 96, lane: 0 }]
    })
    const { rerender } = renderHook(
      ({ id }) =>
        useNativeChatTranscriptWindow({
          scrollRef: { current: scrollElement },
          slots: [slot(id)],
          revealIndex: -1
        }),
      { initialProps: { id: 'message-0' } }
    )

    for (let index = 1; index <= MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS; index += 1) {
      rerender({ id: `message-${index}` })
    }

    expect(virtualizerMock.measure).toHaveBeenCalledOnce()
    expect(virtualizerMock.resizeItem).toHaveBeenCalledExactlyOnceWith(0, 96)
    expect(virtualizerMock.scrollToOffset).toHaveBeenCalledExactlyOnceWith(320)
  })

  it('keeps item-key lookup stable across content-only row revisions', () => {
    const scrollRef = { current: null }
    const { rerender } = renderHook(
      ({ text }) => {
        const current = slot('message-0')
        current.message.blocks = [{ type: 'text', text }]
        return useNativeChatTranscriptWindow({ scrollRef, slots: [current], revealIndex: -1 })
      },
      { initialProps: { text: 'first' } }
    )
    const getItemKey = virtualizerMock.options.current?.getItemKey

    rerender({ text: 'streamed revision' })

    expect(virtualizerMock.options.current?.getItemKey).toBe(getItemKey)
  })
})
