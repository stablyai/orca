// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import * as rowContent from '../../../../shared/native-chat-row-content'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../shared/native-chat-types'
import type { NativeChatResolvedPrompt } from '../../../../shared/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from './native-chat-turn-diffs'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'

function message(id: string, role: NativeChatMessage['role']): NativeChatMessage {
  return {
    id,
    role,
    blocks: [{ type: 'text', text: `body of ${id}` }],
    timestamp: 1,
    source: 'transcript'
  }
}

/** Rebuild slots each call as the transcript does on every render. */
function slotsOf(messages: NativeChatMessage[]) {
  let turn: string | undefined
  const turnKeys = messages.map((entry) => {
    if (entry.role === 'user') {
      turn = entry.id
    }
    return turn
  })
  return buildNativeChatTranscriptSlots({
    messages,
    turnKeys,
    liveTurnKey: undefined,
    receipts: new Map<string, NativeChatResolvedPrompt>(),
    turnStatuses: { active: null, completedByTurn: {} },
    turnDiffs: new Map<string, NativeChatTurnDiff>(),
    expandedTurnKeys: new Set<string>(),
    isWorking: false,
    lifecycleWorking: false
  })
}

/** Only preview tests need the rows backing these slots. */
const NO_ROWS = { messages: [], turnKeys: [] }

const CONVERSATION = [
  message('u1', 'user'),
  message('a1', 'assistant'),
  message('u2', 'user'),
  message('a2', 'assistant'),
  message('u3', 'user')
]

describe('message rail hook', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses previews and rail state during long-history streamed renders', () => {
    const conversation = Array.from({ length: 2000 }, (_, index) =>
      message(`history-${index}`, index % 2 === 0 ? 'user' : 'assistant')
    )
    const scrollRef = { current: document.createElement('div') }
    const { result, rerender, unmount } = renderHook(
      ({ slots }) =>
        useNativeChatMessageRail({ scrollRef, slots, turnRows: NO_ROWS, virtualItems: [] }),
      { initialProps: { slots: slotsOf(conversation) } }
    )
    const initial = result.current
    const derive = vi.spyOn(rowContent, 'deriveNativeChatRowContent')
    for (let revision = 0; revision < 20; revision += 1) {
      const slots = slotsOf([
        ...conversation.slice(0, -1),
        message(`tail-${revision}`, 'assistant')
      ])
      derive.mockClear()
      rerender({ slots })
      expect(derive.mock.calls.length).toBe(0)
      expect(result.current).toBe(initial)
    }
    unmount()
    derive.mockRestore()
  })

  it('keeps the previewed reply current while its turn streams', () => {
    const scrollRef = { current: document.createElement('div') }
    const streamed = (body: string) => {
      const messages = [
        ...CONVERSATION,
        { ...message('a3', 'assistant'), blocks: [{ type: 'text' as const, text: body }] }
      ]
      return {
        slots: slotsOf(messages),
        turnRows: { messages, turnKeys: ['u1', 'u1', 'u2', 'u2', 'u3', 'u3'] }
      }
    }
    const { result, rerender, unmount } = renderHook(
      ({ slots, turnRows }) =>
        useNativeChatMessageRail({ scrollRef, slots, turnRows, virtualItems: [] }),
      { initialProps: streamed('Thinking') }
    )
    expect(result.current.previewReply).toBe('')
    act(() => result.current.onPreview('u3'))
    expect(result.current.previewReply).toBe('Thinking')
    rerender(streamed('Thinking it through'))
    expect(result.current.previewReply).toBe('Thinking it through')
    act(() => result.current.onPreview(null))
    const closed = result.current
    rerender(streamed('Thinking it through, done'))
    expect(result.current).toBe(closed)
    unmount()
  })

  it('removes its scroll listener and pending idle read on unmount', () => {
    vi.useFakeTimers()
    const element = document.createElement('div')
    const remove = vi.spyOn(element, 'removeEventListener')
    const { unmount } = renderHook(() =>
      useNativeChatMessageRail({
        scrollRef: { current: element },
        slots: slotsOf(CONVERSATION),
        turnRows: NO_ROWS,
        virtualItems: []
      })
    )
    act(() => element.dispatchEvent(new Event('scroll')))
    expect(vi.getTimerCount()).toBe(1)
    unmount()
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function))
    expect(vi.getTimerCount()).toBe(0)
    vi.useRealTimers()
  })

  // Depending on fresh slots would cancel the scroll-idle timer on each streaming frame, preventing settlement.
  it('subscribes to scroll once across renders that rebuild the slots', () => {
    const element = document.createElement('div')
    const scrollRef = { current: element }
    const addListener = vi.spyOn(element, 'addEventListener')

    const { rerender } = renderHook(
      ({ slots }) =>
        useNativeChatMessageRail({ scrollRef, slots, turnRows: NO_ROWS, virtualItems: [] }),
      { initialProps: { slots: slotsOf(CONVERSATION) } }
    )
    rerender({ slots: slotsOf(CONVERSATION) })
    rerender({ slots: slotsOf(CONVERSATION) })

    const scrollSubscriptions = addListener.mock.calls.filter(([type]) => type === 'scroll')
    expect(scrollSubscriptions).toHaveLength(1)
  })

  // A clamped jump leaves another row at the fold; keep the clicked tick lit.
  describe('a clicked tick', () => {
    /** Five 100px rows; `u2` (row 2) clamped 50px below the top at max scroll. */
    function clampedJump() {
      vi.useFakeTimers()
      const view = { scrollTop: 150, clientHeight: 300, scrollHeight: 450, shift: 0 }
      const element = document.createElement('div')
      Object.defineProperties(element, {
        scrollTop: { get: () => view.scrollTop },
        clientHeight: { get: () => view.clientHeight },
        scrollHeight: { get: () => view.scrollHeight }
      })
      const scrollRef = { current: element }
      const hook = renderHook(
        ({ slots }) =>
          useNativeChatMessageRail({
            scrollRef,
            slots,
            turnRows: NO_ROWS,
            virtualItems: slots.map((_slot, index) => ({
              key: index,
              index,
              start: view.shift + index * 100,
              end: view.shift + index * 100 + 100,
              size: 100,
              lane: 0
            }))
          }),
        { initialProps: { slots: slotsOf(CONVERSATION) } }
      )
      const settle = (): void =>
        act(() => {
          element.dispatchEvent(new Event('scroll'))
          vi.runAllTimers()
        })
      settle()
      expect(hook.result.current.activeId).toBe('u3')
      act(() => hook.result.current.onActivate('u2'))
      return { ...hook, view, settle }
    }

    it('stays lit while its row stays where the jump settled it', () => {
      const { result, rerender, view, settle, unmount } = clampedJump()
      settle()
      settle()
      expect(result.current.activeId).toBe('u2')
      // Late measurement above the row shifts both content and offset.
      view.shift = 30
      view.scrollTop = 180
      rerender({ slots: slotsOf(CONVERSATION) })
      settle()
      expect(result.current.activeId).toBe('u2')
      view.shift = 0
      view.scrollTop = 50
      rerender({ slots: slotsOf(CONVERSATION.slice(1)) })
      expect(result.current.items.map((item) => item.id)).toEqual(['u2', 'u3'])
      settle()
      expect(result.current.activeId).toBe('u2')
      unmount()
    })

    it('is let go once its row moves, whatever moved it', () => {
      const { result, view, settle, unmount } = clampedJump()
      // Even a jump that fires no scroll must settle.
      act(() => vi.runAllTimers())
      view.scrollTop = 100
      settle()
      expect(result.current.activeId).toBe('u1')
      unmount()
    })

    it('is let go once its row leaves a shrinking viewport', () => {
      const { result, view, settle, unmount } = clampedJump()
      settle()
      view.clientHeight = 40
      settle()
      expect(result.current.activeId).toBe('u1')
      unmount()
    })

    it('is not held when the reader carried its row off screen before it settled', () => {
      const { result, view, settle, unmount } = clampedJump()
      view.scrollTop = 0
      view.clientHeight = 150
      settle()
      expect(result.current.activeId).toBe('u1')
      unmount()
    })
  })

  it('ticks every user message and shows from the first one', () => {
    const element = document.createElement('div')
    Object.defineProperty(element, 'clientWidth', { value: 800 })
    const scrollRef = { current: element }

    const { result } = renderHook(() =>
      useNativeChatMessageRail({
        scrollRef,
        slots: slotsOf(CONVERSATION),
        turnRows: NO_ROWS,
        virtualItems: []
      })
    )
    expect(result.current.items.map((item) => item.id)).toEqual(['u1', 'u2', 'u3'])
    expect(result.current.visible).toBe(true)

    const { result: single } = renderHook(() =>
      useNativeChatMessageRail({
        scrollRef,
        slots: slotsOf([message('u1', 'user'), message('a1', 'assistant')]),
        turnRows: NO_ROWS,
        virtualItems: []
      })
    )
    expect(single.current.visible).toBe(true)

    const { result: empty } = renderHook(() =>
      useNativeChatMessageRail({ scrollRef, slots: [], turnRows: NO_ROWS, virtualItems: [] })
    )
    expect(empty.current.visible).toBe(false)
  })

  it('maps user messages above the loaded window from the outline, before the loaded ones', () => {
    const scrollRef = { current: document.createElement('div') }
    Object.defineProperty(scrollRef.current, 'clientWidth', { value: 800 })
    const outline = Array.from({ length: 30 }, (_, index) => ({
      id: `older-${index}`,
      text: `older prompt ${index}`,
      hasImages: false
    }))
    const loaded = [message('u1', 'user'), message('a1', 'assistant')]
    const { result } = renderHook(() =>
      useNativeChatMessageRail({
        scrollRef,
        slots: slotsOf(loaded),
        turnRows: NO_ROWS,
        virtualItems: [],
        outline
      })
    )
    expect(result.current.visible).toBe(true)
    expect(result.current.items.map((item) => item.id)).toEqual([
      ...outline.map((entry) => entry.id),
      'u1'
    ])
    expect(result.current.items.at(0)).toMatchObject({ slotIndex: null, text: 'older prompt 0' })
    expect(result.current.items.at(-1)).toMatchObject({ id: 'u1', slotIndex: 0 })
    expect(result.current.ticks.at(0)?.id).toBe('older-0')
    expect(result.current.ticks.at(-1)?.id).toBe('u1')
  })
})
