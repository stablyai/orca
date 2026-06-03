import { describe, expect, it } from 'vitest'
import { getContextualTour } from '../../../../shared/contextual-tours'
import {
  getContextualTourRequestDecision,
  getContextualTourStepProgress,
  getContextualTourOutcomeStepTotal,
  getMeasurableContextualTourTarget,
  getNextVisibleContextualTourStepIndex,
  getPreviousVisibleContextualTourStepIndex,
  getVisibleContextualTourStepIndexes,
  isContextualTourAllowedForModal
} from './contextual-tour-gate'

describe('contextual tour gate', () => {
  it('allows only workspace creation over its workspace composer modal', () => {
    const workspaceCreation = getContextualTour('workspace-creation')
    const tasks = getContextualTour('tasks')

    expect(isContextualTourAllowedForModal(workspaceCreation, 'new-workspace-composer')).toBe(true)
    expect(isContextualTourAllowedForModal(workspaceCreation, 'add-repo')).toBe(false)
    expect(isContextualTourAllowedForModal(tasks, 'none')).toBe(true)
    expect(isContextualTourAllowedForModal(tasks, 'new-workspace-composer')).toBe(false)
    expect(isContextualTourAllowedForModal(tasks, 'add-repo')).toBe(false)
  })

  it('does not start when the required first target is missing', () => {
    const decision = getContextualTourRequestDecision({
      tour: getContextualTour('tasks'),
      persistedUIReady: true,
      autoEligible: true,
      onboardingVisible: false,
      seenIds: [],
      sessionConsumed: false,
      activeTourId: null,
      activeModal: 'none',
      blockingSurfaceVisible: false,
      targetExists: () => false
    })

    expect(decision).toEqual({ kind: 'blocked', reason: 'missing-start-target' })
  })

  it('returns null when selector lookup or measurement throws', () => {
    expect(
      getMeasurableContextualTourTarget('[', {
        querySelector: () => {
          throw new Error('bad selector')
        }
      } as unknown as ParentNode)
    ).toBeNull()

    expect(
      getMeasurableContextualTourTarget('[data-contextual-tour-target="tasks-source-filters"]', {
        querySelector: () => ({
          getBoundingClientRect: () => {
            throw new Error('detached element')
          }
        })
      } as unknown as ParentNode)
    ).toBeNull()
  })

  it('returns null when the target is inside a hidden subtree', () => {
    expect(
      getMeasurableContextualTourTarget('[data-contextual-tour-target="browser-address"]', {
        querySelector: () => ({
          closest: (selector: string) => (selector.includes('aria-hidden') ? {} : null),
          getBoundingClientRect: () => ({
            left: 0,
            top: 0,
            right: 120,
            bottom: 32,
            width: 120,
            height: 32
          })
        })
      } as unknown as ParentNode)
    ).toBeNull()
  })

  it('uses the first visible measurable target when hidden mounted copies exist first', () => {
    const hiddenElement = {
      closest: (selector: string) => (selector.includes('aria-hidden') ? {} : null),
      getBoundingClientRect: () => ({
        left: 0,
        top: 0,
        right: 120,
        bottom: 32,
        width: 120,
        height: 32
      })
    }
    const visibleElement = {
      closest: () => null,
      getBoundingClientRect: () => ({
        left: 10,
        top: 20,
        right: 210,
        bottom: 64,
        width: 200,
        height: 44
      })
    }

    const target = getMeasurableContextualTourTarget(
      '[data-contextual-tour-target="browser-address"]',
      {
        querySelectorAll: () => [hiddenElement, visibleElement]
      } as unknown as ParentNode
    )

    expect(target?.element).toBe(visibleElement)
    expect(target?.rect.width).toBe(200)
  })

  it('starts an unseen tour only when global gates pass', () => {
    const tour = getContextualTour('tasks')
    const hasFirstTarget = (selector: string): boolean => selector === tour.steps[0]?.targetSelector

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'start', stepIndex: 0 })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: false,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'persisted-ui-not-ready' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: false,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'auto-disabled' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: true,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'onboarding' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: ['tasks'],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: false,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'seen' })

    expect(
      getContextualTourRequestDecision({
        tour,
        persistedUIReady: true,
        autoEligible: true,
        onboardingVisible: false,
        seenIds: [],
        sessionConsumed: false,
        activeTourId: null,
        activeModal: 'none',
        blockingSurfaceVisible: true,
        targetExists: hasFirstTarget
      })
    ).toEqual({ kind: 'blocked', reason: 'blocking-surface' })
  })

  it('skips missing later steps and keeps progress relative to visible steps', () => {
    const tour = getContextualTour('tasks')
    const visibleSelectors = new Set([tour.steps[0]!.targetSelector, tour.steps[2]!.targetSelector])
    const targetExists = (selector: string): boolean => visibleSelectors.has(selector)
    const visibleStepIndexes = getVisibleContextualTourStepIndexes(tour, targetExists)

    expect(visibleStepIndexes).toEqual([0, 2])
    expect(
      getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 0,
        targetExists
      })
    ).toBe(2)
    expect(
      getPreviousVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 2,
        targetExists
      })
    ).toBe(0)
    expect(
      getPreviousVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 0,
        targetExists
      })
    ).toBeNull()
    expect(getContextualTourStepProgress({ visibleStepIndexes, stepIndex: 2 })).toEqual({
      current: 2,
      total: 2
    })
    expect(getContextualTourOutcomeStepTotal(visibleStepIndexes)).toBe(2)
    expect(getContextualTourOutcomeStepTotal([])).toBe(1)
  })

  it('advances the workspace-agent-sessions tour from split to the create-worktree step', () => {
    const tour = getContextualTour('workspace-agent-sessions')
    const targetExists = (): boolean => true
    const visibleStepIndexes = getVisibleContextualTourStepIndexes(tour, targetExists)

    expect(tour.steps.map((step) => step.title)).toEqual([
      'Split a terminal pane',
      'Start another task in parallel'
    ])
    expect(visibleStepIndexes).toEqual([0, 1])
    expect(
      getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 0,
        targetExists
      })
    ).toBe(1)
    expect(getContextualTourStepProgress({ visibleStepIndexes, stepIndex: 1 })).toEqual({
      current: 2,
      total: 2
    })
  })

  it('cancels the workspace-agent-sessions tour when the new-worktree button is absent', () => {
    const tour = getContextualTour('workspace-agent-sessions')
    // Only the split step's target is present; the create-worktree button is not.
    const targetExists = (selector: string): boolean => selector === tour.steps[0]!.targetSelector
    const visibleStepIndexes = getVisibleContextualTourStepIndexes(tour, targetExists)

    expect(visibleStepIndexes).toEqual([0])
    expect(
      getNextVisibleContextualTourStepIndex({
        tour,
        currentStepIndex: 0,
        targetExists
      })
    ).toBeNull()
  })
})
