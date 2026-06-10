import { describe, expect, it, vi } from 'vitest'
import {
  createContextualTourInteractionSnapshot,
  shouldRequestContextualTourAfterInteraction
} from './use-contextual-tour'
import type { ContextualTourId } from '../../../../shared/contextual-tours'

describe('shouldRequestContextualTourAfterInteraction', () => {
  it('waits for persisted seen ids before allowing a tour request', async () => {
    let resolvePersisted!: () => void
    const persisted = new Promise<void>((resolve) => {
      resolvePersisted = resolve
    })
    const seenIds: ContextualTourId[] = []
    const requestReady = shouldRequestContextualTourAfterInteraction({
      id: 'tasks',
      persisted,
      isCancelled: () => false,
      getContextualToursSeenIds: () => seenIds
    })

    let settled = false
    void requestReady.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    seenIds.push('tasks')
    resolvePersisted()

    await expect(requestReady).resolves.toBe(false)
  })

  it('allows the request when the tour remains unseen after persistence settles', async () => {
    await expect(
      shouldRequestContextualTourAfterInteraction({
        id: 'tasks',
        persisted: Promise.resolve(),
        isCancelled: () => false,
        getContextualToursSeenIds: () => []
      })
    ).resolves.toBe(true)
  })
})

describe('createContextualTourInteractionSnapshot', () => {
  it('records regular contextual-tour feature interactions before requesting', async () => {
    const persisted = Promise.resolve()
    const recordFeatureInteraction = vi.fn(() => persisted)

    const snapshot = createContextualTourInteractionSnapshot({
      id: 'tasks',
      featureInteractions: {},
      recordFeatureInteraction,
      recordFeatureInteractionForTour: true
    })

    expect(recordFeatureInteraction).toHaveBeenCalledWith('tasks')
    expect(snapshot.wasPreviouslyInteracted).toBe(false)
    await expect(snapshot.persisted).resolves.toBeUndefined()
  })

  it('reuses the floating workspace pre-open snapshot without double-recording', async () => {
    const persisted = Promise.resolve()
    const recordFeatureInteraction = vi.fn(() => Promise.resolve())

    const snapshot = createContextualTourInteractionSnapshot({
      id: 'floating-workspace',
      featureInteractions: {
        'floating-workspace': {
          firstInteractedAt: 1,
          interactionCount: 1
        }
      },
      recordFeatureInteraction,
      recordFeatureInteractionForTour: false,
      featureInteractionPersisted: persisted,
      wasFeaturePreviouslyInteracted: false
    })

    expect(recordFeatureInteraction).not.toHaveBeenCalled()
    expect(snapshot.wasPreviouslyInteracted).toBe(false)
    expect(snapshot.persisted).toBe(persisted)
  })

  it('marks existing floating workspace users from the explicit pre-open snapshot', () => {
    const snapshot = createContextualTourInteractionSnapshot({
      id: 'floating-workspace',
      featureInteractions: {},
      recordFeatureInteraction: vi.fn(() => Promise.resolve()),
      recordFeatureInteractionForTour: false,
      wasFeaturePreviouslyInteracted: true
    })

    expect(snapshot.wasPreviouslyInteracted).toBe(true)
  })

  it('can record after hydration while preserving an explicit pre-open snapshot', () => {
    const persisted = Promise.resolve()
    const recordFeatureInteraction = vi.fn(() => persisted)

    const snapshot = createContextualTourInteractionSnapshot({
      id: 'floating-workspace',
      featureInteractions: {
        'floating-workspace': {
          firstInteractedAt: 1,
          interactionCount: 1
        }
      },
      recordFeatureInteraction,
      recordFeatureInteractionForTour: true,
      wasFeaturePreviouslyInteracted: false
    })

    expect(recordFeatureInteraction).toHaveBeenCalledWith('floating-workspace')
    expect(snapshot.wasPreviouslyInteracted).toBe(false)
    expect(snapshot.persisted).toBe(persisted)
  })
})
