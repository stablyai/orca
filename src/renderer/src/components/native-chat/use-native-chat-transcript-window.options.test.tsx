// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import type { VirtualItem } from '@tanstack/react-virtual'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessageSlot } from './native-chat-transcript-slots'

type VirtualizerOptionsCapture = {
  current:
    | ({ count: number; getItemKey: (index: number) => VirtualItem['key'] } & Record<
        string,
        unknown
      >)
    | null
}

type SizeChangeProbe = {
  scrollOffset: number
  scrollDirection: 'forward' | 'backward' | null
  itemSizeCache: Map<string, number>
}
type SizeChangePolicyHolder = {
  shouldAdjustScrollPositionOnItemSizeChange?: (
    item: { index: number; key: string; end: number },
    delta: number,
    instance: SizeChangeProbe
  ) => boolean
}

const virtualizerMock = vi.hoisted(() => {
  const scrollElement: { current: HTMLElement | null } = { current: null }
  /** The instance the hook last received, where it sets its scroll-adjust policy. */
  const instance: { current: SizeChangePolicyHolder | null } = { current: null }
  return {
    options: { current: null } as VirtualizerOptionsCapture,
    instance,
    getTotalSize: vi.fn(() => 0),
    getVirtualItems: vi.fn(() => []),
    measureElement: vi.fn(),
    measure: vi.fn(),
    resizeItem: vi.fn(),
    scrollElement,
    scrollToEnd: vi.fn(),
    scrollToIndex: vi.fn(),
    getOffsetForIndex: vi.fn<(index: number, align: string) => [number, string]>(() => [
      0,
      'start'
    ]),
    scrollToOffset: vi.fn(),
    takeSnapshot: vi.fn<() => VirtualItem[]>(() => [])
  }
})

vi.mock('@tanstack/react-virtual', () => ({
  elementScroll: vi.fn(),
  useVirtualizer: (options: VirtualizerOptionsCapture['current']) => {
    virtualizerMock.options.current = options
    const instance: SizeChangePolicyHolder & Record<string, unknown> = {
      ...virtualizerMock,
      scrollElement: virtualizerMock.scrollElement.current
    }
    virtualizerMock.instance.current = instance
    return instance
  }
}))

const { MAX_RETIRED_NATIVE_CHAT_MEASUREMENTS, useNativeChatTranscriptWindow } =
  await import('./use-native-chat-transcript-window')

function slot(id: string): NativeChatMessageSlot {
  return {
    kind: 'message',
    message: {
      id,
      role: 'assistant',
      blocks: [{ type: 'text', text: id }],
      timestamp: 1,
      source: 'transcript'
    },
    turnKey: undefined,
    activeTurnIsWorking: false,
    trailingRun: false,
    receipt: undefined,
    status: undefined,
    folded: false,
    drawsMessage: true,
    turnFolds: false,
    turnDiff: undefined,
    subagentRoster: undefined,
    depth: 0,
    estimatedHeight: 48
  }
}

afterEach(() => {
  cleanup()
  virtualizerMock.options.current = null
  virtualizerMock.scrollElement.current = null
  vi.clearAllMocks()
})

describe('native chat transcript virtualizer contract', () => {
  it('retains prepend anchoring without geometry-driven end following', () => {
    const { rerender } = renderHook(
      ({ isVisible }) =>
        useNativeChatTranscriptWindow({
          scrollRef: { current: null },
          slots: [],
          isVisible,
          revealIndex: -1
        }),
      { initialProps: { isVisible: false } }
    )

    expect(virtualizerMock.options.current).toMatchObject({
      anchorTo: 'end',
      followOnAppend: false,
      scrollEndThreshold: -1
    })

    rerender({ isVisible: true })

    expect(virtualizerMock.options.current).toMatchObject({
      anchorTo: 'end',
      followOnAppend: false,
      scrollEndThreshold: -1
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
          isVisible: true,
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
        return useNativeChatTranscriptWindow({
          scrollRef,
          slots: [current],
          isVisible: true,
          revealIndex: -1
        })
      },
      { initialProps: { text: 'first' } }
    )
    const getItemKey = virtualizerMock.options.current?.getItemKey

    rerender({ text: 'streamed revision' })

    expect(virtualizerMock.options.current?.getItemKey).toBe(getItemKey)
  })

  it('attributes a clamped fallback landing after content grows before its echo', () => {
    const scrollElement = document.createElement('div')
    let scrollHeight = 1_000
    let scrollTop = 0
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, get: () => 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
      scrollTop: {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
          scrollTop = Math.max(0, Math.min(value, scrollHeight - 100))
        }
      }
    })
    const { result } = renderHook(() =>
      useNativeChatTranscriptWindow({
        scrollRef: { current: scrollElement },
        slots: [slot('message-0')],
        isVisible: true,
        revealIndex: -1
      })
    )

    result.current.scrollToEnd()
    expect(scrollTop).toBe(900)
    scrollHeight = 1_400

    expect(result.current.consumeProgrammaticScroll(new Event('scroll'))).toBe(true)
  })

  it('restores a detached offset through the virtualizer', () => {
    const scrollElement = document.createElement('div')
    virtualizerMock.scrollElement.current = scrollElement
    const { result } = renderHook(() =>
      useNativeChatTranscriptWindow({
        scrollRef: { current: scrollElement },
        slots: [slot('message-0')],
        isVisible: true,
        revealIndex: -1
      })
    )

    result.current.restoreScrollOffset(320)

    expect(virtualizerMock.scrollToOffset).toHaveBeenCalledExactlyOnceWith(320, {
      behavior: 'auto'
    })
  })

  it('lets an explicit reveal supersede a pending reader takeover', () => {
    const scrollElement = document.createElement('div')
    const target = document.createElement('div')
    scrollElement.append(target)
    virtualizerMock.scrollElement.current = scrollElement
    const { result } = renderHook(() =>
      useNativeChatTranscriptWindow({
        scrollRef: { current: scrollElement },
        slots: [slot('message-0')],
        isVisible: true,
        revealIndex: -1
      })
    )

    result.current.reconcileReaderScroll(true)
    result.current.alignToViewportTop(target)
    virtualizerMock.scrollToOffset.mockClear()
    result.current.reconcileReaderScroll(false)

    expect(virtualizerMock.scrollToOffset).not.toHaveBeenCalled()
  })

  // A jump owns the scroll until the view is at its row: layout under it can clamp
  // the view elsewhere first, and no event in between marks its landing reliably.
  it('holds a jump to a row pending until the view reaches it, or the reader takes the scroll', () => {
    const scrollElement = document.createElement('div')
    Object.defineProperties(scrollElement, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, value: 1_000 }
    })
    const row = document.createElement('div')
    row.dataset.index = '3'
    scrollElement.append(row)
    virtualizerMock.scrollElement.current = scrollElement
    virtualizerMock.getOffsetForIndex.mockReturnValue([400, 'start'])
    const { result } = renderHook(() =>
      useNativeChatTranscriptWindow({
        scrollRef: { current: scrollElement },
        slots: [slot('message-0')],
        isVisible: true,
        revealIndex: -1
      })
    )
    expect(result.current.isAlignPending()).toBe(false)

    result.current.alignToViewportTop(row)
    expect(virtualizerMock.scrollToIndex).toHaveBeenCalledWith(
      3,
      expect.objectContaining({ align: 'start' })
    )
    scrollElement.scrollTop = 900
    expect(result.current.isAlignPending()).toBe(true)
    scrollElement.scrollTop = 401
    expect(result.current.isAlignPending()).toBe(false)

    // A measured row growing above the view just after an upward scroll: left alone
    // for a reader scrolling up, compensated under a jump resting where it landed.
    const compensates = (heard = scrollElement.scrollTop): boolean | undefined =>
      virtualizerMock.instance.current?.shouldAdjustScrollPositionOnItemSizeChange?.(
        { index: 1, key: 'row-1', end: 300 },
        18,
        {
          scrollOffset: heard,
          scrollDirection: 'backward',
          itemSizeCache: new Map([['row-1', 100]])
        }
      )
    expect(compensates()).toBe(true)
    // Not from an offset the virtualizer has yet to hear of: an instant jump just
    // wrote the view elsewhere, and a correction from the old offset would undo it.
    expect(compensates(scrollElement.scrollTop + 500)).toBe(false)

    result.current.alignToViewportTop(row)
    scrollElement.scrollTop = 700
    result.current.cancelAlign()
    expect(result.current.isAlignPending()).toBe(false)
    expect(compensates()).toBe(false)
    expect(virtualizerMock.scrollToOffset).toHaveBeenLastCalledWith(700, { behavior: 'auto' })
  })

  // Rows drawn after the window (a message shown as not sent) still fill the container.
  it('follows the bottom of the container when no row is windowed', () => {
    const container = document.createElement('div')
    Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 2000 })
    virtualizerMock.scrollElement.current = container
    const noSlots: NativeChatMessageSlot[] = []
    const { result, rerender } = renderHook(
      ({ slots }) =>
        useNativeChatTranscriptWindow({
          scrollRef: { current: container },
          slots,
          isVisible: true,
          revealIndex: -1
        }),
      { initialProps: { slots: noSlots } }
    )

    result.current.scrollToEnd()
    expect(virtualizerMock.scrollToEnd).not.toHaveBeenCalled()
    expect(container.scrollTop).toBe(2000)

    rerender({ slots: [slot('a')] })
    result.current.scrollToEnd()
    expect(virtualizerMock.scrollToEnd).toHaveBeenCalledOnce()
  })
})
