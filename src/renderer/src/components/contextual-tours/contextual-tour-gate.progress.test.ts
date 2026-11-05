import { describe, expect, it } from 'vitest'
import { getContextualTour, isContextualTourStepDone } from '../../../../shared/contextual-tours'
import type {
  FeatureInteractionId,
  FeatureInteractionState
} from '../../../../shared/feature-interactions'
import { getContextualTourRequestDecision } from './contextual-tour-gate'

const tour = getContextualTour('workspace-agent-sessions')

function decide(done: FeatureInteractionId[], allowStartAfterProgress = false) {
  const featureInteractions: FeatureInteractionState = Object.fromEntries(
    done.map((id) => [id, { firstInteractedAt: 1, interactionCount: 1 }])
  )
  return getContextualTourRequestDecision({
    tour,
    persistedUIReady: true,
    autoEligible: true,
    onboardingVisible: false,
    seenIds: [],
    allowStartAfterProgress,
    sessionConsumed: false,
    activeTourId: null,
    activeModal: 'none',
    blockingSurfaceVisible: false,
    // Terminal tab active: the + menu, terminal split and new-workspace targets are measurable.
    targetExists: (selector) => !selector.includes('chat-pane-split-target'),
    isStepDone: (step) => isContextualTourStepDone(step, featureInteractions)
  })
}

describe('workspace agent sessions tour start', () => {
  it('starts at + for users who have not split, even after using tabs', () => {
    expect(decide([])).toEqual({ kind: 'start', stepIndex: 0 })
    expect(decide(['terminal-tabs'])).toEqual({ kind: 'start', stepIndex: 0 })
  })

  it('does not reopen for users who already split a terminal or a chat', () => {
    expect(decide(['terminal-pane-split'])).toEqual({
      kind: 'blocked',
      reason: 'already-progressed'
    })
    expect(decide(['tab-splits'])).toEqual({ kind: 'blocked', reason: 'already-progressed' })
  })

  it('still shows the next tip when the tour is already running this session', () => {
    expect(decide(['terminal-pane-split'], true)).toEqual({ kind: 'start', stepIndex: 3 })
  })
})
