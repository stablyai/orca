import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import { selectPetAnimationName } from './pet-agent-state'

const NOW = 10_000

function done(paneKey: string, overrides: Partial<AgentStatusEntry> = {}): AgentStatusEntry {
  return {
    state: 'done',
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey,
    stateHistory: [],
    ...overrides
  }
}

function select(entries: AgentStatusEntry[], acknowledgedAgentsByPaneKey: Record<string, number>) {
  return selectPetAnimationName({
    entries,
    acknowledgedAgentsByPaneKey,
    dragging: false,
    dragAnimation: null,
    hovering: false,
    now: NOW,
    staleAfterMs: 1_000
  })
}

describe('selectPetAnimationName acknowledgement', () => {
  it('plays review only for finished turns the user has not acknowledged', () => {
    expect(select([done('a')], {})).toBe('review')
    expect(select([done('a')], { a: NOW - 1 })).toBe('review')
    expect(select([done('a')], { b: NOW })).toBe('review')
    expect(select([done('a')], { a: NOW })).toBe('idle')
    expect(select([done('a'), done('b')], { a: NOW })).toBe('review')
  })

  it('reads a session boundary as the acknowledged turn it restates', () => {
    const boundary = done('a', {
      sessionBoundary: true,
      stateHistory: [{ state: 'done', prompt: '', startedAt: NOW - 500 }]
    })
    expect(select([boundary], { a: NOW - 500 })).toBe('idle')
    expect(select([boundary], {})).toBe('review')
  })
})
