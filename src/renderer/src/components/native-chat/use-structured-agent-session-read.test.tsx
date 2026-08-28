// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  AgentJournalCursor,
  AgentJournalRenderItem
} from '../../../../shared/agent-session-journal-types'
import {
  AGENT_SESSION_HISTORY_MAX_LIMIT,
  type AgentSessionHistoryPage
} from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe
}))

import { useStructuredAgentSessionRead } from './use-structured-agent-session-read'

const LOCAL_TARGET = { kind: 'local' } as const

function message(id: string, sequence: number, role: 'user' | 'assistant'): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role, blocks: [{ type: 'text', text: id }] }
  }
}

function providerFrame(id: string, sequence: number): AgentJournalRenderItem {
  return {
    itemId: id,
    revision: 1,
    sequence,
    observedAt: sequence,
    body: {
      kind: 'status',
      text: id,
      providerFrame: {
        provider: 'codex',
        kind: 'notification:item/commandExecution/outputDelta',
        payload: { head: id, byteLength: id.length, digest: id, truncated: false }
      }
    }
  }
}

function page(
  direction: 'tail' | 'before',
  items: AgentJournalRenderItem[],
  hasOlder: boolean
): AgentSessionHistoryPage {
  const cursor = (sequence: number): AgentJournalCursor => ({ epoch: 'epoch-a', sequence })
  const oldest = items[0]?.sequence ?? 0
  const newest = items.at(-1)?.sequence ?? oldest
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction,
    items,
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: items.length > 0 ? cursor(oldest) : null,
      newest: items.length > 0 ? cursor(newest) : null,
      nextCursor: cursor(oldest)
    },
    liveCursor: cursor(500),
    hasOlder,
    hasNewer: direction === 'before'
  }
}

describe('useStructuredAgentSessionRead history window', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  it('restores a realistic 21-turn window across the wire-safe bridge-sized read', async () => {
    const items = Array.from({ length: 21 }, (_, turn) => [
      message(`user-${turn}`, turn * 2 + 1, 'user'),
      message(`assistant-${turn}`, turn * 2 + 2, 'assistant')
    ]).flat()
    const olderItems = items.slice(0, 12)
    const tailItems = [
      ...Array.from({ length: 170 }, (_, index) => providerFrame(`delta-${index}`, 43 + index)),
      ...items.slice(12).map((item, index) => ({ ...item, sequence: 213 + index }))
    ]
    mocks.call
      .mockResolvedValueOnce({ ok: true, page: page('tail', tailItems, true) })
      .mockResolvedValueOnce({ ok: true, page: page('before', olderItems, false) })

    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )

    await waitFor(() =>
      expect(
        result.current.state.items.filter((item) => item.body.kind === 'message')
      ).toHaveLength(items.length)
    )
    expect(mocks.call).toHaveBeenNthCalledWith(1, LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-a',
      direction: 'tail',
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    expect(mocks.call).toHaveBeenNthCalledWith(2, LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-a',
      direction: 'before',
      cursor: { epoch: 'epoch-a', sequence: tailItems[0].sequence },
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
  })

  it('loads each earlier page at the wire maximum', async () => {
    const tailItems = Array.from({ length: 200 }, (_, index) =>
      message(`tail-${index}`, 301 + index, 'assistant')
    )
    const initialOlderItems = Array.from({ length: 100 }, (_, index) =>
      message(`middle-${index}`, 201 + index, 'assistant')
    )
    mocks.call
      .mockResolvedValueOnce({
        ok: true,
        page: page('tail', tailItems, true)
      })
      .mockResolvedValueOnce({
        ok: true,
        page: page('before', initialOlderItems, true)
      })
      .mockResolvedValueOnce({
        ok: true,
        page: page('before', [message('oldest', 1, 'user')], false)
      })

    const { result } = renderHook(() =>
      useStructuredAgentSessionRead({ sessionId: 'session-a', target: LOCAL_TARGET })
    )
    await waitFor(() => expect(result.current.state.hasOlder).toBe(true))

    await act(async () => result.current.loadOlder())

    expect(mocks.call).toHaveBeenLastCalledWith(LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-a',
      direction: 'before',
      cursor: { epoch: 'epoch-a', sequence: 201 },
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    expect(result.current.state.items).toHaveLength(301)
    expect(result.current.state.items[0]?.itemId).toBe('oldest')
  })

  it('refreshes only visible structured sessions when the app regains focus', async () => {
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    mocks.call.mockResolvedValue({ ok: true, page: page('tail', [], false) })
    const visible = renderHook(() =>
      useStructuredAgentSessionRead({
        sessionId: 'session-visible',
        target: LOCAL_TARGET,
        isVisible: true
      })
    )
    const hidden = renderHook(() =>
      useStructuredAgentSessionRead({
        sessionId: 'session-hidden',
        target: LOCAL_TARGET,
        isVisible: false
      })
    )
    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(2))

    act(() => window.dispatchEvent(new Event('focus')))

    await waitFor(() => expect(mocks.call).toHaveBeenCalledTimes(3))
    expect(mocks.call).toHaveBeenLastCalledWith(LOCAL_TARGET, 'agentSession.history', {
      sessionId: 'session-visible',
      direction: 'tail',
      limit: AGENT_SESSION_HISTORY_MAX_LIMIT
    })
    visible.unmount()
    hidden.unmount()
    hasFocus.mockRestore()
  })
})
