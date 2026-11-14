import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { requestContextualTourWhenReady } from './request-contextual-tour-when-ready'

describe('requestContextualTourWhenReady', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('can wait for another tour to clear before requesting the target tour', () => {
    vi.useFakeTimers()
    let activeContextualTourId: string | null = 'workspace-agent-sessions'
    const requestContextualTour = vi.fn(() => {
      activeContextualTourId = 'workspace-creation'
    })
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId,
          requestContextualTour
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    requestContextualTourWhenReady({
      id: 'workspace-creation',
      source: 'workspace_creation_modal',
      retryDelayMs: 10,
      maxAttempts: 5,
      waitForActiveTourToClear: true
    })

    vi.advanceTimersByTime(0)
    expect(requestContextualTour).not.toHaveBeenCalled()

    activeContextualTourId = null
    vi.advanceTimersByTime(10)

    expect(requestContextualTour).toHaveBeenCalledTimes(1)
    expect(requestContextualTour).toHaveBeenLastCalledWith(
      'workspace-creation',
      'workspace_creation_modal',
      undefined,
      { force: true }
    )
  })
})
