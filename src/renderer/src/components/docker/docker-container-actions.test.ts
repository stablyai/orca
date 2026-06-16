import { describe, expect, it } from 'vitest'
import { availableActionsForState } from './docker-container-actions'

describe('availableActionsForState', () => {
  it('running → stop, restart, pause, remove', () => {
    expect(availableActionsForState('running')).toEqual(['stop', 'restart', 'pause', 'remove'])
  })
  it('paused → unpause, stop, remove', () => {
    expect(availableActionsForState('paused')).toEqual(['unpause', 'stop', 'remove'])
  })
  it('exited → start, remove', () => {
    expect(availableActionsForState('exited')).toEqual(['start', 'remove'])
  })
  it('created → start, remove', () => {
    expect(availableActionsForState('created')).toEqual(['start', 'remove'])
  })
  it('unknown → remove only', () => {
    expect(availableActionsForState('unknown')).toEqual(['remove'])
  })
})
