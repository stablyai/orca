import type { ContextualTourStep } from '../../../../shared/contextual-tours'
import { describe, expect, it } from 'vitest'
import { getContextualTour } from '../../../../shared/contextual-tours'
import {
  getContextualTourStartStepIndex,
  getNextVisibleContextualTourStepIndex,
  getVisibleContextualTourStepIndexes
} from './contextual-tour-gate'

describe('agent sessions tour progress', () => {
  it.each([
    ['terminal', 'terminal-pane-split'],
    ['agent-session', 'tab-splits']
  ] as const)(
    'resumes after the matching %s split without replaying New agents',
    (activeType, event) => {
      const tour = getContextualTour('workspace-agent-sessions')
      const splitDone = (step: ContextualTourStep): boolean =>
        step.advanceOnFeatureInteraction === event
      expect(getContextualTourStartStepIndex(tour, () => true, splitDone, activeType)).toBe(3)
      expect(
        getContextualTourStartStepIndex(
          tour,
          () => true,
          (step) =>
            splitDone(step) || step.advanceOnFeatureInteraction === 'project-add-introduction',
          activeType
        )
      ).toBe(4)
      const noIntroduction = (selector: string): boolean =>
        !selector.includes('project-add-control')
      expect(
        getContextualTourStartStepIndex(tour, noIntroduction, splitDone, activeType)
      ).toBeNull()
      expect(
        getNextVisibleContextualTourStepIndex({
          tour,
          currentStepIndex: activeType === 'terminal' ? 2 : 1,
          targetExists: noIntroduction,
          isStepDone: splitDone,
          activeTabType: activeType
        })
      ).toBe(3)
    }
  )

  it('keeps the active terminal lesson when only the chat split was completed', () => {
    expect(
      getContextualTourStartStepIndex(
        getContextualTour('workspace-agent-sessions'),
        () => true,
        (step) => step.advanceOnFeatureInteraction === 'tab-splits',
        'terminal'
      )
    ).toBe(0)
  })

  it('waits for the matching split when later controls are absent', () => {
    const tour = getContextualTour('workspace-agent-sessions')
    const targetExists = (selector: string): boolean => selector === tour.steps[0]!.targetSelector
    const visibleStepIndexes = getVisibleContextualTourStepIndexes(tour, targetExists)

    expect(visibleStepIndexes).toEqual([0])
    expect(
      getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 0,
        targetExists,
        activeTabType: 'terminal'
      })
    ).toBe(2)
  })
})
