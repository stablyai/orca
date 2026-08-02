import { describe, expect, it } from 'vitest'
import type { AgentStatusEntry, AgentStatusState } from '../../../../shared/agent-status-types'
import { nextPetDragAnimation, selectPetAnimationName } from './pet-agent-state'

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
    dragAnimation: null,
    hovering: false,
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

  it('keeps the live agent state while grabbed and held still (no drag direction)', () => {
    expect(select([entry('blocked')], { dragging: true })).toBe('waiting')
    expect(select([entry('working')], { dragging: true })).toBe('running')
    expect(select([], { dragging: true })).toBe('idle')
  })

  it('runs toward the drag direction while the pet is dragged horizontally', () => {
    expect(select([entry('blocked')], { dragging: true, dragAnimation: 'running-right' })).toBe(
      'running-right'
    )
    expect(select([], { dragging: true, dragAnimation: 'running-left' })).toBe('running-left')
  })

  it('uses jumping while hovered but not dragging', () => {
    expect(select([], { hovering: true })).toBe('jumping')
    expect(select([entry('working')], { hovering: true })).toBe('jumping')
  })

  it('prefers the live state over hover while grabbed (drag suppresses the hover jump)', () => {
    expect(select([entry('working')], { dragging: true, hovering: true })).toBe('running')
  })
})

describe('nextPetDragAnimation', () => {
  it('keeps the direction and baseline for sub-threshold horizontal travel', () => {
    expect(nextPetDragAnimation(null, 3)).toEqual({ animation: null, accepted: false })
    expect(nextPetDragAnimation('running-right', -3)).toEqual({
      animation: 'running-right',
      accepted: false
    })
  })

  it('picks the horizontal direction at the 4px threshold and advances the baseline', () => {
    expect(nextPetDragAnimation(null, 4)).toEqual({
      animation: 'running-right',
      accepted: true
    })
    expect(nextPetDragAnimation(null, -4)).toEqual({
      animation: 'running-left',
      accepted: true
    })
  })

  it('keeps the last direction without advancing when horizontal travel stays under 4px', () => {
    // A vertical/near-vertical drag has ~0 horizontal delta: keep the direction
    // but do not reset the baseline, so accumulated horizontal travel still adds
    // up toward the threshold on a slow diagonal drag.
    expect(nextPetDragAnimation('running-left', 0)).toEqual({
      animation: 'running-left',
      accepted: false
    })
    expect(nextPetDragAnimation(null, 0)).toEqual({ animation: null, accepted: false })
  })
})
