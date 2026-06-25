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

  it('defers recording to the tour hook when opened before persisted UI is ready', () => {
    const featureInteractions: FeatureInteractionState = {}
    const recordFeatureInteraction = vi.fn(() => Promise.resolve())

    const snapshot = createFloatingWorkspaceTourInteractionSnapshot({
      featureInteractions,
      persistedUIReady: false,
      recordFeatureInteraction
    })

    expect(recordFeatureInteraction).not.toHaveBeenCalled()
    expect(snapshot.wasPreviouslyInteracted).toBeUndefined()
    expect(snapshot.persisted).toBeUndefined()
    expect(snapshot.recordFeatureInteractionForTour).toBe(true)
  })

  it('preserves returning-user state while recording the new open interaction', () => {
    const persisted = Promise.resolve()
    const recordFeatureInteraction = vi.fn(() => persisted)

    const snapshot = createFloatingWorkspaceTourInteractionSnapshot({
      featureInteractions: {
        'floating-workspace': {
          firstInteractedAt: 100,
          interactionCount: 1
        }
      },
      persistedUIReady: true,
      recordFeatureInteraction
    })

    expect(recordFeatureInteraction).toHaveBeenCalledWith('floating-workspace')
    expect(snapshot.wasPreviouslyInteracted).toBe(true)
    expect(snapshot.persisted).toBe(persisted)
    expect(snapshot.recordFeatureInteractionForTour).toBe(false)
  })
})
