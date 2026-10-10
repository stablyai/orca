import { describe, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'

function batch(
  sequence: number,
  backgroundTasks?: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>['backgroundTasks'],
  activity?: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>['activity']
): Extract<AgentSessionSubscribeEvent, { type: 'batch' }> {
  return {
    type: 'batch',
    sessionId: 'session-1',
    batch: {
      cursor: { epoch: 'epoch-1', sequence },
      items: [],
      removedItemIds: [],
      submissions: []
    },
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {}),
    ...(activity !== undefined ? { activity } : {})
  }
}

describe('structured agent session event coalescer', () => {
  it('preserves background task state when a journal batch follows it', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push(
      batch(1, {
        state: 'monitoring',
        tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
      })
    )
    coalescer.push(batch(2))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      backgroundTasks: {
        state: 'monitoring',
        tasks: [{ id: 'task-1', kind: 'command', description: 'run the build' }]
      }
    })
  })

  it('keeps an explicit terminal state as the newest coalesced value', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push(batch(1, { state: 'monitoring' }))
    coalescer.push(batch(1, null))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ backgroundTasks: null })
  })

  it('keeps only the latest ephemeral activity value', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push(batch(1, undefined, { turnId: 'turn-1', text: 'Thinking' }))
    coalescer.push(batch(1, undefined, { turnId: 'turn-1', text: 'Checking the result' }))
    coalescer.push(batch(1, undefined, null))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ activity: null })
  })

  it('delivers each queue list at once, in order, each with the pause it was published with', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const draft = {
      messageId: 'draft-1',
      position: 1,
      body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
      state: 'waiting' as const
    }

    coalescer.push({ ...batch(1), queuedMessages: [draft], queuePause: { reason: 'stopped' } })
    coalescer.push({ ...batch(2), queuedMessages: [], queuePause: null })
    // A later frame with no list leaves the delivered ones as they are.
    coalescer.push(batch(3))
    coalescer.flush()

    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({
      queuedMessages: [draft],
      queuePause: { reason: 'stopped' }
    })
    expect(events[1]).toMatchObject({ queuedMessages: [], queuePause: null })
    expect(events[2]).not.toHaveProperty('queuedMessages')
  })

  it('passes a queue list through at once, with anything it held merged ahead of it', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    coalescer.push(batch(1))
    coalescer.push({
      ...batch(2),
      queuedMessages: [
        {
          messageId: 'card-1',
          position: 1,
          body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'queued' }] },
          state: 'waiting'
        }
      ],
      queuePause: null
    })
    // No wait for the coalescing delay: the card lands with the frame that carries it.
    expect(events.map((event) => event.type === 'batch' && event.batch.cursor.sequence)).toEqual([
      1, 2
    ])
    expect(events[1]).toMatchObject({ queuedMessages: [{ messageId: 'card-1' }] })
    coalescer.dispose()
  })

  it("delivers the queue's next card with its list, ahead of a later token batch", () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    coalescer.push({ ...batch(1), queuedMessages: [], nextQueuedMessageId: 'draft-1' })
    const token = {
      itemId: 'assistant-1',
      revision: 1,
      sequence: 2,
      observedAt: 2,
      body: {
        kind: 'message' as const,
        role: 'assistant' as const,
        blocks: [{ type: 'text' as const, text: 'streaming' }]
      }
    }
    const tokens = batch(2)
    coalescer.push({ ...tokens, batch: { ...tokens.batch, items: [token] } })
    coalescer.flush()
    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({ nextQueuedMessageId: 'draft-1' })
    expect(events[1]).not.toHaveProperty('queuedMessages')
  })

  it('keeps the latest turn a coalesced frame carried, and a null one as an answer', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const running = {
      itemId: 'turn-1',
      observedAt: 1,
      turn: { turnId: 'turn-1', state: 'running' as const }
    }

    coalescer.push({ ...batch(1), latestTurn: running })
    coalescer.push(batch(2))
    coalescer.flush()
    coalescer.push({ ...batch(3), latestTurn: running })
    coalescer.push({ ...batch(4), latestTurn: null })
    coalescer.flush()

    expect(events.map((event) => (event.type === 'batch' ? event.latestTurn : 'other'))).toEqual([
      running,
      null
    ])
  })
  it('drops it when a later frame carries rows without it, as applying both would', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const token = (sequence: number) => ({
      ...batch(sequence),
      batch: {
        ...batch(sequence).batch,
        items: [
          {
            itemId: `token-${sequence}`,
            revision: 1,
            sequence,
            observedAt: sequence,
            body: { kind: 'message' as const, role: 'assistant' as const, blocks: [] }
          }
        ]
      }
    })
    const running = {
      itemId: 'turn-1',
      observedAt: 1,
      turn: { turnId: 'turn-1', state: 'running' as const }
    }

    // The second frame is an older host's: rows, and no answer to keep the first one alive.
    coalescer.push({ ...token(1), latestTurn: running })
    coalescer.push(token(2))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).not.toHaveProperty('latestTurn')
  })
})
