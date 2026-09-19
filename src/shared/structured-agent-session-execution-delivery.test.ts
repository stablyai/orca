import { expect, it } from 'vitest'
import type { AgentSessionExecutionView } from './agent-session-execution-view'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession,
  type StructuredAgentSessionState
} from './structured-agent-session-reducer'

const execution: AgentSessionExecutionView = {
  sessionId: 'session',
  location: {
    executionHostId: 'local',
    wslDistro: null,
    workspaceId: 'folder',
    workspaceKind: 'folder'
  },
  hostIncarnation: 'host',
  revision: 1,
  fence: 1,
  cursor: { epoch: 'a', sequence: 3 },
  observation: 'live',
  activity: 'working',
  control: 'native',
  turnId: 'turn',
  promptIds: [],
  recovery: false,
  historicalStatus: 'working'
}
function ready(): StructuredAgentSessionState {
  return {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    epoch: 'a',
    cursor: execution.cursor,
    status: 'ready',
    execution
  }
}
function batch(view?: AgentSessionExecutionView, epoch = 'a'): AgentSessionSubscribeEvent {
  return {
    type: 'batch',
    sessionId: 'session',
    execution: view,
    batch: { cursor: { epoch, sequence: 3 }, items: [], submissions: [], removedItemIds: [] }
  }
}
function snapshot(view?: AgentSessionExecutionView): AgentSessionSubscribeEvent {
  return {
    type: 'snapshot',
    sessionId: 'session',
    fence: 1,
    execution: view,
    page: {
      sessionId: 'session',
      epoch: 'a',
      direction: 'tail',
      items: [],
      submissions: [],
      removedItemIds: [],
      window: { oldest: null, newest: null, nextCursor: execution.cursor },
      liveCursor: execution.cursor,
      hasOlder: false,
      hasNewer: false
    }
  }
}

it('preserves the newest ordered execution metadata when empty batches coalesce', () => {
  let state = ready()
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    state = reduceStructuredAgentSession(state, { type: 'event', event })
  })
  coalescer.push(batch({ ...execution, revision: 4, turnId: 'new-turn' }))
  coalescer.push(batch({ ...execution, revision: 3, turnId: 'stale-turn' }))
  coalescer.push(batch())
  coalescer.flush()
  expect(state.execution).toMatchObject({ revision: 4, turnId: 'new-turn' })
})

it('delivers revocation immediately after queued assistant text, then rejects stale positives', () => {
  let state = ready()
  const coalescer = createStructuredAgentSessionEventCoalescer((event) => {
    state = reduceStructuredAgentSession(state, { type: 'event', event })
  }, 60_000)
  coalescer.push({
    type: 'batch',
    sessionId: 'session',
    execution,
    batch: {
      cursor: execution.cursor,
      removedItemIds: [],
      submissions: [],
      items: [
        {
          itemId: 'text',
          revision: 1,
          sequence: 3,
          observedAt: 3,
          body: { kind: 'message', role: 'assistant', blocks: [{ type: 'text', text: 'partial' }] }
        }
      ]
    }
  })
  coalescer.push(
    batch({ ...execution, revision: 2, observation: 'unverifiable', control: 'none', turnId: null })
  )
  expect(state.items).toHaveLength(1)
  expect(state.execution?.control).toBe('none')
  coalescer.push(batch(execution))
  coalescer.flush()
  expect(state.execution?.control).toBe('none')
  coalescer.dispose()
})

it('never grants control using a rejected different-epoch batch cursor', () => {
  const state = ready()
  const other = {
    ...execution,
    revision: 2,
    cursor: { epoch: 'b', sequence: 3 },
    turnId: 'other-turn'
  }
  const rejected = reduceStructuredAgentSession(state, { type: 'event', event: batch(other, 'b') })
  expect(rejected).toBe(state)
  const revoked = reduceStructuredAgentSession(state, {
    type: 'event',
    event: batch({ ...other, control: 'none', observation: 'unverifiable' }, 'b')
  })
  expect(revoked.epoch).toBe('a')
  expect(revoked.execution?.control).toBe('none')
})

it.each(['snapshot', 'resume'] as const)(
  'does not resurrect old execution after an older host %s',
  (mode) => {
    const disconnected = reduceStructuredAgentSession(ready(), { type: 'disconnected' })
    expect(disconnected.status).toBe('loading')
    expect(disconnected.execution).toBeUndefined()
    const restored = reduceStructuredAgentSession(disconnected, {
      type: 'event',
      event: mode === 'snapshot' ? snapshot() : batch()
    })
    expect(restored.status).toBe('ready')
    expect(restored.execution).toBeUndefined()
  }
)

it('revokes an end frame while preserving the transcript cursor', () => {
  const ended = reduceStructuredAgentSession(ready(), { type: 'event', event: { type: 'end' } })
  expect(ended.status).toBe('loading')
  expect(ended.execution).toBeUndefined()
  expect(ended.cursor).toEqual(execution.cursor)
})
