import { describe, expect, it } from 'vitest'

import type {
  FeatureInteractionId,
  FeatureInteractionState
} from '../../../../shared/feature-interactions'
import { isContextualTourStartBlockedByProgress } from '../../store/slices/ui/ui-slice-tour-actions'

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
})
