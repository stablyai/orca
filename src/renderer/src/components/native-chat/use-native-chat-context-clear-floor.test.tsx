// @vitest-environment happy-dom

import { NativeChatViewIdentity, retireNativeChatViewState } from './native-chat-view-state-memory'
import { useNativeChatNewRowsMarker } from './native-chat-new-rows-marker'
import { buildNativeChatTranscriptSlots } from './native-chat-transcript-slots'
import { projectStructuredAgentSessionMessages } from './structured-agent-session-message-projection'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
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
  return renderHook(
    ({ epoch, items }) => {
      const { rows, clearing, clears } = useNativeChatContextClearFloor(epoch, items)
      return { shown: rows.map((row) => row.sequence), clearing, clears }
    },
    { initialProps: { epoch, items } }
  )
}

describe('useNativeChatContextClearFloor', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fades a live /clear out before the transcript moves to its divider', () => {
    const hook = render('epoch-a', [message(1), message(2)])
    expect(hook.result.current).toEqual({ shown: [1, 2], clearing: false, clears: 0 })

    hook.rerender({ epoch: 'epoch-a', items: [message(1), message(2), clear(3)] })
    expect(hook.result.current).toEqual({ shown: [1, 2, 3], clearing: true, clears: 0 })

    act(() => vi.advanceTimersByTime(NATIVE_CHAT_CONTEXT_CLEAR_FADE_MS))
    expect(hook.result.current).toEqual({ shown: [3], clearing: false, clears: 1 })
  })

  it('moves to a divider paged in from history without fading or replacing the list', () => {
    const hook = render('epoch-a', [message(40), message(41)])
    hook.rerender({ epoch: 'epoch-a', items: [message(10), clear(11), message(40), message(41)] })
    expect(hook.result.current).toEqual({ shown: [11, 40, 41], clearing: false, clears: 0 })
  })

  it('takes the divider a first read or a rewind loads without fading', () => {
    const hook = render(null, [])
    hook.rerender({ epoch: 'epoch-a', items: [message(1), clear(2), message(3)] })
    expect(hook.result.current).toEqual({ shown: [2, 3], clearing: false, clears: 0 })
  })
})

type VisitRead = {
  epoch: string | null
  items: AgentJournalRenderItem[]
  showing: boolean
  current: boolean
  floor?: number
}
function visitRead(key: string, initialProps: VisitRead) {
  return renderHook(
    (props: VisitRead) => {
      const cut = useNativeChatContextClearFloor(props.epoch, props.items, {
        current: props.current,
        floor:
          props.floor === undefined
            ? undefined
            : { epoch: props.epoch ?? '', sequence: props.floor },
        read: {
          status: 'ready',
          cursor: { epoch: props.epoch ?? '', sequence: props.items.at(-1)?.sequence ?? 0 }
        }
      })
      const messages = projectStructuredAgentSessionMessages(cut.rows, [], [])
      const slots = buildNativeChatTranscriptSlots({
        messages,
        turnKeys: messages.map(() => undefined),
        receipts: new Map(),
        turnStatuses: { active: null, completedByTurn: {} },
        turnDiffs: new Map(),
        expandedTurnKeys: new Set(),
        isWorking: false,
        liveTurnKey: undefined,
        lifecycleWorking: false
      })
      const visit = useNativeChatNewRowsMarker(
        slots,
        [],
        props.showing && props.current,
        cut.applied,
        props.current
      )
      return { ...visit, clearing: cut.clearing, applied: cut.applied }
    },
    {
      initialProps,
      wrapper: ({ children }) => (
        <NativeChatViewIdentity value={key}>{children}</NativeChatViewIdentity>
      )
    }
  )
}

it('retains a consumed visit through park/unknown/history, and resets only at the actual live or parked applied clear', () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
  const key = 'applied-clear-visit'
  const read = (items: AgentJournalRenderItem[], showing = true, current = true): VisitRead => ({
    epoch: 'e',
    items,
    showing,
    current
  })
  const view = visitRead(key, read([message(1), message(2)]))
  view.rerender(read([message(1), message(2)], false))
  view.rerender(read([message(1), message(2), message(3)]))
  expect(view.result.current.marker).toMatchObject({ key: 'row-3', arriving: true })
  act(() => view.result.current.marker?.onArrived())
  view.rerender(read([], false, false))
  view.unmount()
  let back = visitRead(key, read([message(1), message(2), message(3)]))
  expect(back.result.current.marker).toMatchObject({ key: 'row-3', arriving: false })
  // A newly paged historical divider is not a replacement of this visit.
  back.rerender(read([clear(1), message(2), message(3)]))
  expect(back.result.current.marker?.key).toBe('row-3')
  // Save the pre-clear tail through the actual fade, including disposal mid-fade.
  back.rerender(read([clear(1), message(2), message(3), clear(4), message(5)]))
  expect(back.result.current.clearing).toBe(true)
  expect(back.result.current.applied).toEqual({ epoch: 'e', floor: 1, tail: 3 })
  expect(back.result.current.marker?.key).toBe('row-3')
  back.unmount()
  back = visitRead(key, read([clear(4), message(5)]))
  expect(back.result.current.marker).toBeUndefined()
  back.rerender(read([message(3)]))
  expect(back.result.current.marker).toBeUndefined()
  back.rerender(read([clear(4), message(5)]))
  back.rerender(read([clear(4), message(5)], false))
  back.rerender(read([clear(4), message(5), message(6)]))
  expect(back.result.current.marker?.key).toBe('row-6')
  act(() => back.result.current.marker?.onArrived())
  back.unmount()
  back = visitRead(key, read([clear(4), message(5), message(6)]))
  expect(back.result.current.marker).toMatchObject({ key: 'row-6', arriving: false })
  back.rerender({ ...read([]), epoch: null, current: false })
  back.rerender(read([message(5), message(6)]))
  expect(back.result.current.marker?.key).toBe('row-6')
  // Epoch-qualified applied host floor covers a divider outside a caught-up loaded tail.
  back.rerender({ ...read([message(9)]), floor: 8 })
  expect(back.result.current.marker).toBeUndefined()
  back.rerender(read([message(9)], false))
  back.rerender(read([message(9), message(10)]))
  expect(back.result.current.marker?.key).toBe('row-10')
  back.rerender({ ...read([message(9), message(10)]), epoch: 'replacement' })
  expect(back.result.current.marker).toBeUndefined()
  back.unmount()
  retireNativeChatViewState(key)
  vi.restoreAllMocks()
  vi.useRealTimers()
})
