import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { selectPetAnimationName } from './pet-agent-state'

const NOW = 1_000
const STALE_AFTER_MS = 500

function entry(
  state: AgentStatusState,
  overrides: Partial<AgentStatusEntry> = {}
): AgentStatusEntry {
  return {
    state,
    prompt: '',
    updatedAt: NOW,
    stateStartedAt: NOW,
    paneKey: `tab:${state}`,
    stateHistory: [],
    ...overrides
  }
}

function select(
  entries: AgentStatusEntry[],
  options: Partial<Parameters<typeof selectPetAnimationName>[0]> = {}
) {
  return selectPetAnimationName({
    entries,
    retainedCount: 0,
    dragging: false,
    now: NOW,
    staleAfterMs: STALE_AFTER_MS,
    ...options
  })
}

describe('selectPetAnimationName', () => {
  it('uses idle when no fresh agent state exists', () => {
    expect(select([])).toBe('idle')
    expect(select([entry('working', { updatedAt: NOW - STALE_AFTER_MS - 1 })])).toBe('idle')
  })

  it('maps live work to running', () => {
    expect(select([entry('working')])).toBe('running')
  })

  it('maps blocked and waiting states to waiting', () => {
    expect(select([entry('blocked')])).toBe('waiting')
    expect(select([entry('waiting')])).toBe('waiting')
  })

  it('prioritizes attention-needed states over running work', () => {
    expect(select([entry('working'), entry('blocked')])).toBe('waiting')
  })

  it('maps completed live or retained work to review', () => {
    expect(select([entry('done')])).toBe('review')
    expect(select([], { retainedCount: 1 })).toBe('review')
  })

  it('maps interrupted completion to review because Orca does not expose failure as a state', () => {
    expect(select([entry('done', { interrupted: true })])).toBe('review')
    expect(select([entry('working'), entry('done', { interrupted: true })])).toBe('running')
  })

  it('uses jumping while the pet is being dragged', () => {
    expect(select([entry('blocked')], { dragging: true })).toBe('jumping')
  })
})
