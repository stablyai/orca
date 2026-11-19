import { describe, expect, it } from 'vitest'
import type { AgentMapToolCall } from './agent-session-map-model'
import { agentMapToolChipsAt } from './agent-session-map-tool-chips'

function call(
  overrides: Partial<AgentMapToolCall> & { callId: string; name: string }
): AgentMapToolCall {
  return {
    summary: '',
    state: 'completed',
    startTs: 1000,
    ...overrides
  }
}

describe('agentMapToolChipsAt', () => {
  it('groups calls per name in first-start order', () => {
    const chips = agentMapToolChipsAt(
      [
        call({ callId: '1', name: 'Bash', startTs: 1000, endTs: 2000 }),
        call({ callId: '2', name: 'Read', startTs: 1500, endTs: 2500 }),
        call({ callId: '3', name: 'Bash', startTs: 3000, endTs: 4000 })
      ],
      5000
    )
    expect(chips.map((chip) => [chip.name, chip.count])).toEqual([
      ['Bash', 2],
      ['Read', 1]
    ])
    expect(chips[0].completed).toBe(2)
  })

  it('counts a call as running until its endTs passes the cursor', () => {
    const calls = [
      call({ callId: '1', name: 'Bash', startTs: 1000, state: 'running', endTs: 9000 }),
      call({ callId: '2', name: 'Bash', startTs: 1000, state: 'failed', endTs: 3000 })
    ]
    expect(agentMapToolChipsAt(calls, 4000)[0]).toMatchObject({
      count: 2,
      running: 1,
      failed: 1,
      completed: 0
    })
    expect(agentMapToolChipsAt(calls, 10000)[0]).toMatchObject({ running: 0, failed: 1 })
  })

  it('ignores calls that start after the cursor and returns empty for none', () => {
    expect(agentMapToolChipsAt([call({ callId: '1', name: 'Bash', startTs: 9000 })], 5000)).toEqual(
      []
    )
    expect(agentMapToolChipsAt([], 5000)).toEqual([])
  })
})
