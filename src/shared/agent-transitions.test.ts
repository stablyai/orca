import { describe, expect, it } from 'vitest'
import {
  agentPhaseTransition,
  hookRowAgentPhase,
  hookRowTransition,
  nextAgentPhase,
  titleAgentPhase,
  type AgentPhase
} from './agent-transitions'
import { AGENT_TRANSITION_SCENARIOS } from './agent-transitions.test-fixture'

const PHASES: readonly AgentPhase[] = ['rest', 'working', 'needs-you', 'done']

describe('hookRowAgentPhase', () => {
  it('maps hook states to phases, and a stopped turn to Rest', () => {
    expect(hookRowAgentPhase({ state: 'working' })).toBe('working')
    expect(hookRowAgentPhase({ state: 'blocked' })).toBe('needs-you')
    expect(hookRowAgentPhase({ state: 'waiting' })).toBe('needs-you')
    expect(hookRowAgentPhase({ state: 'done' })).toBe('done')
    expect(hookRowAgentPhase({ state: 'done', interrupted: true })).toBe('rest')
    expect(
      hookRowAgentPhase({ state: 'done', mainAgent: { state: 'done', outcome: 'cancellation' } })
    ).toBe('rest')
    // An error is news: it ranks as Done, like a finish.
    expect(
      hookRowAgentPhase({ state: 'done', mainAgent: { state: 'done', outcome: 'failure' } })
    ).toBe('done')
  })
})

describe('titleAgentPhase', () => {
  it('reads the title heuristic Smart uses', () => {
    expect(titleAgentPhase('⠋ Codex working')).toBe('working')
    expect(titleAgentPhase('zsh')).toBe('rest')
  })
})

describe('agentPhaseTransition', () => {
  it('names the news in every phase change', () => {
    const table = Object.fromEntries(
      PHASES.flatMap((from) =>
        PHASES.map((to) => [`${from} -> ${to}`, agentPhaseTransition(from, to)])
      )
    )
    expect(table).toEqual({
      'rest -> rest': null,
      'rest -> working': 'prompt-submitted',
      'rest -> needs-you': 'needs-input',
      'rest -> done': 'turn-finished',
      'working -> rest': null,
      'working -> working': null,
      'working -> needs-you': 'needs-input',
      'working -> done': 'turn-finished',
      'needs-you -> rest': null,
      'needs-you -> working': null,
      'needs-you -> needs-you': null,
      'needs-you -> done': 'turn-finished',
      'done -> rest': null,
      'done -> working': 'prompt-submitted',
      'done -> needs-you': 'needs-input',
      'done -> done': null
    })
  })

  it('tells a failed turn from a finish only by its row', () => {
    const failed = {
      state: 'done' as const,
      mainAgent: { state: 'done' as const, outcome: 'failure' as const }
    }
    expect(hookRowTransition('working', 'done', failed)).toBe('errored')
    expect(hookRowTransition('working', 'done', { state: 'done' })).toBe('turn-finished')
    expect(hookRowTransition('done', 'done', failed)).toBeNull()
  })

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
