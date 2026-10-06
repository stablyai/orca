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

  it('preserves a queued-message list when later coalesced frames omit it', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const list = [
      {
        messageId: 'draft-1',
        position: 1,
        body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
        state: 'waiting' as const
      }
    ]

    coalescer.push({ ...batch(1), queuedMessages: list })
    coalescer.push(batch(2))
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ queuedMessages: list })
  })

  it('keeps the latest queued-message list, an emptied one included', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push({
      ...batch(1),
      queuedMessages: [
        {
          messageId: 'draft-1',
          position: 1,
          body: { kind: 'message' as const, role: 'user' as const, blocks: [] },
          state: 'waiting' as const
        }
      ]
    })
    coalescer.push({ ...batch(2), queuedMessages: [] })
    coalescer.flush()

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ queuedMessages: [] })
  })

  it('keeps the queue pause with the list it was published with', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))

    coalescer.push({ ...batch(1), queuedMessages: [], queuePause: { reason: 'restarted' } })
    coalescer.push(batch(2))
    coalescer.flush()
    expect(events[0]).toMatchObject({ queuedMessages: [], queuePause: { reason: 'restarted' } })

    coalescer.push({ ...batch(3), queuedMessages: [], queuePause: null })
    coalescer.push({ ...batch(4), queuedMessages: [], queuePause: { reason: 'stopped' } })
    coalescer.flush()
    expect(events[1]).toMatchObject({ queuePause: { reason: 'stopped' } })
  })
})
