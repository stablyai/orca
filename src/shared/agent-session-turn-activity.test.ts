import { describe, expect, it } from 'vitest'
import { agentSessionTurnActivityEqual } from './agent-session-turn-activity'

const activity = (subagents: string[], session = false) => ({
  turnId: 'turn-1',
  text: '',
  reasoning: { session, subagents }
})

describe('live turn activity equality', () => {
  it('compares subagent ids one by one, whatever characters they hold', () => {
    expect(agentSessionTurnActivityEqual(activity(['a\nb']), activity(['a', 'b']))).toBe(false)
    expect(agentSessionTurnActivityEqual(activity(['a', 'b']), activity(['a', 'b']))).toBe(true)
    expect(agentSessionTurnActivityEqual(activity(['a']), activity(['a'], true))).toBe(false)
  })

  it('reads null and absent as the same: no activity', () => {
    expect(agentSessionTurnActivityEqual(null, undefined)).toBe(true)
    expect(agentSessionTurnActivityEqual(null, activity([]))).toBe(false)
  })
})
