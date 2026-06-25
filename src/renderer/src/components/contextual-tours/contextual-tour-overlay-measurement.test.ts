import { describe, expect, it } from 'vitest'
import { getContextualTour } from '../../../../shared/contextual-tours'
import {
  getContextualTourDisplayProgress,
  getContextualTourMeasurementAction,
  isContextualTourLastDisplayStep
} from './contextual-tour-overlay-measurement'

describe('contextual tour overlay measurement', () => {
  it('shows all defined browser steps in progress even when step 3 is hidden', () => {
    const tour = getContextualTour('browser')

    expect(
      getContextualTourDisplayProgress({
        tour,
        visibleStepIndexes: [0, 1],
        stepIndex: 1,
        activeStep: tour.steps[1]
      })
    ).toEqual({ current: 2, total: 3 })
  })

  it('waits for the browser cookie step target instead of cancelling', () => {
    const tour = getContextualTour('browser')

    expect(
      getContextualTourMeasurementAction({
        tour,
        visibleStepIndexes: [0, 1],
        activeStepIndex: 2
      })
    ).toEqual({ kind: 'wait' })
  })

  it('treats browser step 3 as the last display step', () => {
    const tour = getContextualTour('browser')

    expect(
      isContextualTourLastDisplayStep({
        tour,
        activeStepIndex: 2,
        progress: { current: 3, total: 3 }
      })
    ).toBe(true)
  })
})
