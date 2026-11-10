// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS,
  useNativeChatContextClearFloor
} from './use-native-chat-context-clear-floor'

const message = (sequence: number): AgentJournalRenderItem => ({
  itemId: `row-${sequence}`,
  sequence,
  revision: 1,
  observedAt: sequence,
  body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'reply' }] }
})
const clear = (sequence: number): AgentJournalRenderItem => ({
  ...message(sequence),
  body: {
    kind: 'status',
    text: 'Context cleared',
    presentation: 'context-cleared',
    contextClear: { operationId: `clear-${sequence}`, afterFence: 1, clearedAt: sequence }
  }
})

function render(epoch: string | null, items: AgentJournalRenderItem[]) {
  let restore = (): void => {}
  const hook = renderHook(
    ({ epoch, items }) => {
      const { rows, clearing, clears, onClearSent } = useNativeChatContextClearFloor(epoch, items)
      return { view: { shown: rows.map((row) => row.sequence), clearing, clears }, onClearSent }
    },
    { initialProps: { epoch, items } }
  )
  return {
    rerender: hook.rerender,
    get view() {
      return hook.result.current.view
    },
    sendClear: () => act(() => void (restore = hook.result.current.onClearSent())),
    refuseClear: () => act(() => restore())
  }
}

describe('useNativeChatContextClearFloor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fades a live /clear out before the transcript moves to its divider', () => {
    const hook = render('epoch-a', [message(1), message(2)])
    expect(hook.view).toEqual({ shown: [1, 2], clearing: false, clears: 0 })

    hook.rerender({ epoch: 'epoch-a', items: [message(1), message(2), clear(3)] })
    expect(hook.view).toEqual({ shown: [1, 2, 3], clearing: true, clears: 0 })

    act(() => vi.advanceTimersByTime(NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS))
    expect(hook.view).toEqual({ shown: [3], clearing: false, clears: 1 })
  })

  it('hides the transcript from the moment a /clear is sent until its divider lands', () => {
    const hook = render('epoch-a', [message(1), message(2)])
    hook.sendClear()
    expect(hook.view).toEqual({ shown: [1, 2], clearing: true, clears: 0 })

    // Already faded out by the time the divider lands, so it swaps without a second fade.
    act(() => vi.advanceTimersByTime(NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS))
    hook.rerender({ epoch: 'epoch-a', items: [message(1), message(2), clear(3)] })
    act(() => vi.advanceTimersByTime(0))
    expect(hook.view).toEqual({ shown: [3], clearing: false, clears: 1 })

    // The answered press hides nothing once later history trims its divider out.
    hook.rerender({ epoch: 'epoch-a', items: [message(4), message(5)] })
    expect(hook.view.clearing).toBe(false)
  })

  it('shows the transcript again when a sent /clear is refused', () => {
    const hook = render('epoch-a', [message(1), message(2)])
    hook.sendClear()
    expect(hook.view.clearing).toBe(true)
    hook.refuseClear()
    expect(hook.view).toEqual({ shown: [1, 2], clearing: false, clears: 0 })
  })

  it('stops hiding once a snapshot past the divider holds none of the rows the press hid', () => {
    const hook = render('epoch-a', [message(1), message(2)])
    hook.sendClear()
    hook.rerender({ epoch: 'epoch-a', items: [message(9), message(10)] })
    expect(hook.view).toEqual({ shown: [9, 10], clearing: false, clears: 0 })
  })

  it('moves to a divider paged in from history without fading or replacing the list', () => {
    const hook = render('epoch-a', [message(40), message(41)])
    hook.rerender({ epoch: 'epoch-a', items: [message(10), clear(11), message(40), message(41)] })
    expect(hook.view).toEqual({ shown: [11, 40, 41], clearing: false, clears: 0 })
  })

  it('takes the divider a first read or a rewind loads without fading', () => {
    const hook = render(null, [])
    hook.rerender({ epoch: 'epoch-a', items: [message(1), clear(2), message(3)] })
    expect(hook.view).toEqual({ shown: [2, 3], clearing: false, clears: 0 })
  })
})
