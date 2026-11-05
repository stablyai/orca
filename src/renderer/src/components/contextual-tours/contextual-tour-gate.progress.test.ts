import { describe, expect, it } from 'vitest'
import { getContextualTour, isContextualTourStepDone } from '../../../../shared/contextual-tours'
import type {
  FeatureInteractionId,
  FeatureInteractionState
} from '../../../../shared/feature-interactions'
import { isContextualTourStartBlockedByProgress } from '../../store/slices/ui/ui-slice-tour-actions'
import { getContextualTourRequestDecision } from './contextual-tour-gate'

const TOUR_ID = 'workspace-agent-sessions'

function interactions(done: FeatureInteractionId[]): FeatureInteractionState {
  return Object.fromEntries(done.map((id) => [id, { firstInteractedAt: 1, interactionCount: 1 }]))
}

function blocked(done: FeatureInteractionId[], startedThisSession = false): boolean {
  return isContextualTourStartBlockedByProgress(
    {
      featureInteractions: interactions(done),
      contextualToursStartedThisSession: startedThisSession ? [TOUR_ID] : []
    },
    TOUR_ID
  )
}

describe('workspace agent sessions tour after progress', () => {
  it('still starts for users who have not split, even after using tabs', () => {
    expect(blocked([])).toBe(false)
    expect(blocked(['terminal-tabs'])).toBe(false)
  })

  it('does not reopen for users who already split a terminal or a chat', () => {
    expect(blocked(['terminal-pane-split'])).toBe(true)
    expect(blocked(['tab-splits'])).toBe(true)
  })

  it('continues a tour started this session at the next tip instead of rewinding to +', () => {
    expect(blocked(['terminal-pane-split'], true)).toBe(false)
    const featureInteractions = interactions(['terminal-pane-split'])
    const decision = getContextualTourRequestDecision({
      tour: getContextualTour(TOUR_ID),
      persistedUIReady: true,
      autoEligible: true,
      onboardingVisible: false,
      seenIds: [],
      progressBlocked: false,
      sessionConsumed: false,
      activeTourId: null,
      activeModal: 'none',
      blockingSurfaceVisible: false,
      // Terminal tab active: the + menu, terminal split and new-workspace targets are measurable.
      targetExists: (selector) => !selector.includes('chat-pane-split-target'),
      isStepDone: (step) => isContextualTourStepDone(step, featureInteractions)
    })
    expect(decision).toEqual({ kind: 'start', stepIndex: 3 })
  })
})
