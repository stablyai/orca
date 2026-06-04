import { describe, expect, it } from 'vitest'
import { shouldRequestContextualTourAfterInteraction } from './use-contextual-tour'
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
