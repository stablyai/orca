// @vitest-environment happy-dom

// Prefer host evidence for the current agent so ended agents’ stale turns read stopped; derive from rows for older hosts.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'
import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'

afterEach(cleanup)

/** A turn row an agent that has since ended left running. */
const LEFT_RUNNING: AgentJournalRenderItem = {
  itemId: 'turn-1',
  sequence: 1,
  revision: 1,
  observedAt: 1,
  body: {
    kind: 'status',
    text: 'Working',
    turnLifecycle: { turnId: 'turn-1', state: 'running' }
  }
}

function page(fields: Partial<AgentSessionHistoryPage> = {}): AgentSessionHistoryPage {
  const cursor = { epoch: 'epoch-a', sequence: 1 }
  return {
    sessionId: 'session-a',
    epoch: 'epoch-a',
    direction: 'tail',
    items: [LEFT_RUNNING],
    removedItemIds: [],
    submissions: [],
    window: { oldest: cursor, newest: cursor, nextCursor: cursor },
    liveCursor: cursor,
    hasOlder: false,
    hasNewer: false,
    ...fields
  }
}

function loaded(fields: Partial<AgentSessionHistoryPage>): StructuredAgentSessionState {
  return reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'history-page',
    page: page(fields)
  })
}

function isWorking(state: StructuredAgentSessionState): boolean {
  return renderHook(() => useStructuredAgentSessionTransportState(state, true)).result.current
    .isWorking
}

describe('the chat’s Working', () => {
  it('is the host’s answer: a turn an ended agent left running reads as stopped', () => {
    expect(isWorking(loaded({ working: false }))).toBe(false)
    expect(isWorking(loaded({ items: [], working: true }))).toBe(true)
  })

  it('falls back to the rows when an older host gives no answer', () => {
    expect(loaded({}).working).toBeUndefined()
    expect(isWorking(loaded({}))).toBe(true)
  })
})
