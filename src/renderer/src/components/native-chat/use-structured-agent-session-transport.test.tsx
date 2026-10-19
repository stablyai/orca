// A hidden chat pane reads nothing: a message sent from it is settled by its own reply, not by the
// journal read.

// @vitest-environment happy-dom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'

const mocks = vi.hoisted(() => ({ call: vi.fn(), subscribe: vi.fn() }))

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: mocks.call,
  subscribeStructuredAgentSession: mocks.subscribe,
  supportsStructuredAgentSessionPromptCancel: vi.fn().mockResolvedValue(false)
}))

import { useStructuredAgentSessionTransport } from './use-structured-agent-session-transport'
import { resetStructuredAgentSessionReadOwnersForTests } from './structured-agent-session-read-owner'

const LOCAL_TARGET = { kind: 'local' } as const

function emptyPage(): AgentSessionHistoryPage {
  const cursor = (sequence: number): AgentJournalCursor => ({ epoch: 'epoch-a', sequence })
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items: [],
    removedItemIds: [],
    submissions: [],
    window: { oldest: null, newest: null, nextCursor: cursor(0) },
    liveCursor: cursor(0),
    hasOlder: false,
    hasNewer: false
  }
}

function renderTransport(sessionId: string, isVisible: boolean) {
  return renderHook(() =>
    useStructuredAgentSessionTransport({
      sessionId,
      target: LOCAL_TARGET,
      isVisible,
      enabled: true
    })
  )
}

describe('useStructuredAgentSessionTransport reads', () => {
  afterEach(cleanup)

  beforeEach(() => {
    vi.clearAllMocks()
    resetStructuredAgentSessionReadOwnersForTests()
    mocks.call.mockResolvedValue({ ok: true, page: emptyPage() })
    mocks.subscribe.mockResolvedValue({ unsubscribe: vi.fn() })
  })

  it('reads a visible session', async () => {
    const view = renderTransport('session-visible', true)

    await waitFor(() => expect(mocks.subscribe).toHaveBeenCalledTimes(1))
    view.unmount()
  })

  it('leaves a hidden session unread', async () => {
    const view = renderTransport('session-hidden', false)

    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.subscribe).not.toHaveBeenCalled()
    view.unmount()
  })
})
