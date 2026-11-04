import { describe, expect, it } from 'vitest'
import {
  hookRowAgentPhase,
  hookRowTransition,
  nextAgentPhase,
  type AgentPhase
} from './agent-transitions'
import { AGENT_TRANSITION_SCENARIOS } from './agent-transitions.test-fixture'

describe('agentPhaseTransition', () => {
  it('names no news for a session boundary, whose phase still reads done', () => {
    const boundary = { state: 'done' as const, sessionBoundary: true }
    expect(hookRowAgentPhase(boundary)).toBe('done')
    expect(hookRowTransition('working', 'done', boundary)).toBeNull()
    expect(hookRowTransition('needs-you', 'done', boundary)).toBeNull()
  })
})

describe('agent transition scenarios', () => {
  it.each(AGENT_TRANSITION_SCENARIOS)('$name', ({ steps }) => {
    let phase: AgentPhase = 'rest'
    for (const { row, transition } of steps) {
      const to = nextAgentPhase(phase, hookRowAgentPhase(row))
      expect(hookRowTransition(phase, to, row)).toBe(transition)
      phase = to
    }
  })
})
