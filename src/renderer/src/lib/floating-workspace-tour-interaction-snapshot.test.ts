import { describe, expect, it, vi } from 'vitest'
import { createFloatingWorkspaceTourInteractionSnapshot } from './floating-workspace-tour-interaction-snapshot'
import type { FeatureInteractionState } from '../../../shared/feature-interactions'

describe('createFloatingWorkspaceTourInteractionSnapshot', () => {
  it('captures first-open state before recording the floating workspace interaction', () => {
    const featureInteractions: FeatureInteractionState = {}
    const persisted = Promise.resolve()
    const recordFeatureInteraction = vi.fn(() => {
      featureInteractions['floating-workspace'] = {
        firstInteractedAt: 100,
        interactionCount: 1
      }
      return persisted
    })

    const snapshot = createFloatingWorkspaceTourInteractionSnapshot({
      featureInteractions,
      persistedUIReady: true,
      recordFeatureInteraction
    })

    expect(recordFeatureInteraction).toHaveBeenCalledOnce()
    expect(recordFeatureInteraction).toHaveBeenCalledWith('floating-workspace')
    expect(snapshot.wasPreviouslyInteracted).toBe(false)
    expect(snapshot.persisted).toBe(persisted)
    expect(snapshot.recordFeatureInteractionForTour).toBe(false)
  })
})
