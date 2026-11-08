import { describe, expect, it } from 'vitest'
import { getContextualTour } from '../../../../shared/contextual-tours'
import { getContextualTourDisplayProgress } from './contextual-tour-overlay-measurement'

const tour = getContextualTour('workspace-agent-sessions')

function progress(visibleStepIndexes: number[], stepIndex: number) {
  return getContextualTourDisplayProgress({
    tour,
    visibleStepIndexes,
    stepIndex,
    activeStep: tour.steps[stepIndex]
  })
}

describe('workspace agent sessions tour progress', () => {
  it('keeps the split lesson counted after a chat split focuses its landing', () => {
    expect(progress([0, 1, 3], 1)).toEqual({ current: 2, total: 3 })
    expect(progress([0, 3], 3)).toEqual({ current: 3, total: 3 })
  })

  it('counts a still-visible split lesson once', () => {
    expect(progress([0, 2, 3], 3)).toEqual({ current: 3, total: 3 })
  })
})
