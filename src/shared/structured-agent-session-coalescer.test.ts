import { describe, expect, it } from 'vitest'
import type { AgentSessionSubscribeEvent } from './agent-session-wire'
import { createStructuredAgentSessionEventCoalescer } from './structured-agent-session-coalescer'

function batch(
  sequence: number,
  backgroundTasks?: Extract<AgentSessionSubscribeEvent, { type: 'batch' }>['backgroundTasks']
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
    ...(backgroundTasks !== undefined ? { backgroundTasks } : {})
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
})
