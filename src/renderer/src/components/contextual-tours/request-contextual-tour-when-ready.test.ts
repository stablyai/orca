import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { requestContextualTourWhenReady } from './request-contextual-tour-when-ready'

describe('requestContextualTourWhenReady', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('retries a forced tour request until the target starts', () => {
    vi.useFakeTimers()
    let activeContextualTourId: string | null = null
    const requestContextualTour = vi.fn(() => {
      if (requestContextualTour.mock.calls.length === 3) {
        activeContextualTourId = 'workspace-agent-sessions'
      }
    })
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId,
          requestContextualTour
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    requestContextualTourWhenReady({
      id: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      retryDelayMs: 10,
      maxAttempts: 5
    })

    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(10)
    vi.advanceTimersByTime(10)
    vi.advanceTimersByTime(20)

    expect(requestContextualTour).toHaveBeenCalledTimes(3)
    expect(requestContextualTour).toHaveBeenLastCalledWith(
      'workspace-agent-sessions',
      'setup_guide_parallel_work',
      undefined,
      { force: true }
    )
  })

  it('stops when another tour becomes active before the target starts', () => {
    vi.useFakeTimers()
    let activeContextualTourId: string | null = null
    const requestContextualTour = vi.fn(() => {
      activeContextualTourId = 'tasks'
    })
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId,
          requestContextualTour
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    requestContextualTourWhenReady({
      id: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      retryDelayMs: 10,
      maxAttempts: 5
    })

    vi.advanceTimersByTime(0)
    vi.advanceTimersByTime(50)

    expect(requestContextualTour).toHaveBeenCalledTimes(1)
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

  it('cancels pending retries when the caller unmounts or starts another action', () => {
    vi.useFakeTimers()
    const requestContextualTour = vi.fn()
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId: null,
          requestContextualTour
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    const cancel = requestContextualTourWhenReady({
      id: 'workspace-agent-sessions',
      source: 'setup_guide_parallel_work',
      retryDelayMs: 10,
      maxAttempts: 5
    })

    vi.advanceTimersByTime(0)
    cancel()
    vi.advanceTimersByTime(50)

    expect(requestContextualTour).toHaveBeenCalledTimes(1)
  })

  it('stops before requesting when the destination surface is no longer current', () => {
    vi.useFakeTimers()
    const requestContextualTour = vi.fn()
    const shouldContinue = vi.fn(() => false)
    vi.spyOn(useAppStore, 'getState').mockImplementation(
      () =>
        ({
          activeContextualTourId: null,
          requestContextualTour
        }) as unknown as ReturnType<typeof useAppStore.getState>
    )

    requestContextualTourWhenReady({
      id: 'workspace-creation',
      source: 'setup_guide_parallel_work',
      shouldContinue,
      retryDelayMs: 10,
      maxAttempts: 5
    })

    vi.advanceTimersByTime(50)

    expect(shouldContinue).toHaveBeenCalledTimes(1)
    expect(requestContextualTour).not.toHaveBeenCalled()
  })
})
