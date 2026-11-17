import { describe, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from '../../agent-session-wire'
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
    // Queue cards must bypass the coalescing delay.
    expect(events.map((event) => event.type === 'batch' && event.batch.cursor.sequence)).toEqual([
      1, 2
    ])
    expect(events[1]).toMatchObject({ queuedMessages: [{ messageId: 'card-1' }] })
    coalescer.dispose()
  })
  it('ends a catch-up only when the last page it merged did', () => {
    const events: AgentSessionSubscribeEvent[] = []
    const coalescer = createStructuredAgentSessionEventCoalescer((event) => events.push(event))
    const page = (sequence: number, hasNewer: boolean) => ({
      ...batch(sequence),
      ...(hasNewer ? { hasNewer: true as const } : {})
    })

    coalescer.push(page(1, true))
    coalescer.push(page(2, true))
    coalescer.flush()
    coalescer.push(page(3, true))
    coalescer.push(page(4, false))
    coalescer.flush()

    expect(events.map((event) => event.type === 'batch' && event.hasNewer === true)).toEqual([
      true,
      false
    ])
  })
})
