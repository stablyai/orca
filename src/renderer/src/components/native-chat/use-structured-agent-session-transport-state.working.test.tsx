// @vitest-environment happy-dom

// Whether the chat's own agent is working is the host's answer when it gives one: it counts only
// the agent running now, so a turn an ended agent left running reads as stopped and Resume shows.
// An older host gives none, and the chat derives it from its rows as before.

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionHistoryPage } from '../../../../shared/agent-session-wire'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from '../../../../shared/structured-agent-session-reducer'

vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: vi.fn()
}))

import { useStructuredAgentSessionTransportState } from './use-structured-agent-session-transport-state'
import { useStructuredAgentSessionQueuedMessages } from './use-structured-agent-session-queued-messages'
import { useStructuredAgentSessionMutate } from './use-structured-agent-session-mutate'

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

  it('follows a frame that restates it with no row, and keeps it across a frame that names none', () => {
    const stopped = reduceStructuredAgentSession(loaded({ working: true }), {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          items: [],
          removedItemIds: [],
          submissions: [],
          cursor: { epoch: 'epoch-a', sequence: 1 }
        },
        working: false
      }
    })
    expect(stopped.working).toBe(false)
    expect(isWorking(stopped)).toBe(false)
    const quiet = reduceStructuredAgentSession(stopped, {
      type: 'event',
      event: {
        type: 'batch',
        sessionId: 'session-a',
        batch: {
          items: [],
          removedItemIds: [],
          submissions: [],
          cursor: { epoch: 'epoch-a', sequence: 1 }
        }
      }
    })
    expect(quiet.working).toBe(false)
  })

  it('offers Resume over held cards once the host says the agent stopped; an older host’s rows hide it', () => {
    const held = {
      queuePause: { reason: 'stopped' as const },
      queuedMessages: [
        {
          messageId: 'held',
          position: 1,
          body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
          state: 'waiting' as const
        }
      ]
    }
    const resume = (state: StructuredAgentSessionState) =>
      renderHook(() => {
        const transport = useStructuredAgentSessionTransportState(state, true)
        const { mutate } = useStructuredAgentSessionMutate({
          sessionId: 'session-a',
          target: { kind: 'local' },
          stateRef: { current: { fence: 1 } }
        })
        return useStructuredAgentSessionQueuedMessages({
          enabled: true,
          queuedMessages: transport.queuedMessages ?? [],
          queuePause: transport.queuePause,
          submissions: [],
          hasPendingPrompt: false,
          isWorking: transport.isWorking,
          composerScopeKey: undefined,
          mutate,
          editTransport: {
            target: { kind: 'local' },
            sessionId: 'session-a',
            capable: false,
            write: async () => ({ kind: 'dropped' })
          }
        })
      }).result.current.queueResume
    expect(resume(loaded({ ...held, working: false }))).toBeDefined()
    expect(resume(loaded(held))).toBeUndefined()
  })
})
