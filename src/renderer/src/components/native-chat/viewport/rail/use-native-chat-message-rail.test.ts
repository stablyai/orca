// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeChatMessage } from '../../../../../../shared/native-chat/native-chat-types'
import type { NativeChatResolvedPrompt } from '../../../../../../shared/native-chat/native-chat-resolution-receipt'
import type { NativeChatTurnDiff } from '../../../../../../shared/native-chat/tools/native-chat-turn-diffs'
import { buildNativeChatTranscriptSlots } from '../../conversation/slots/native-chat-transcript-slots'
import { useNativeChatMessageRail } from './use-native-chat-message-rail'
import { buildNativeChatRailItems } from './native-chat-message-rail-items'

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

    it('is not held when the reader carried its row off screen before it settled', () => {
      const { result, view, settle, unmount } = clampedJump()
      view.scrollTop = 0
      view.clientHeight = 150
      settle()
      expect(result.current.activeId).toBe('u1')
      unmount()
    })
  })
})

describe('loaded rail items', () => {
  it('gives no tick to a message another agent wrote', () => {
    const task: NativeChatMessage = {
      ...message('task', 'user'),
      from: {
        kind: 'agent',
        senders: [],
        orchestration: { message: 'task', runId: 'run-1', taskId: 'task-1', dispatchId: 'd-1' }
      }
    }
    const slots = slotsOf([task, message('a0', 'assistant'), ...CONVERSATION])
    expect(buildNativeChatRailItems(slots).map((item) => item.id)).toEqual(['u1', 'u2', 'u3'])
  })
})
