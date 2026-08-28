// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import {
  installWindowVisibilitySubscriptionParking,
  WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT,
  WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS,
  WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS,
  type WindowVisibilitySubscriptionSpec
} from './window-visibility-subscription-parking'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function setDocumentVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state
  })
  document.dispatchEvent(new Event('visibilitychange'))
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function resolvedSpec() {
  const currents: (() => boolean)[] = []
  const unsubscribes: ReturnType<typeof vi.fn>[] = []
  const subscribe = vi.fn(async (isCurrent: () => boolean) => {
    currents.push(isCurrent)
    const unsubscribe = vi.fn()
    unsubscribes.push(unsubscribe)
    return { unsubscribe }
  })
  return {
    currents,
    spec: { subscribe } satisfies WindowVisibilitySubscriptionSpec,
    subscribe,
    unsubscribes
  }
}

describe('installWindowVisibilitySubscriptionParking', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setDocumentVisibility('visible')
  })

  afterEach(() => {
    setDocumentVisibility('visible')
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('parks every subscription after the grace and restarts them on reveal', async () => {
    const first = resolvedSpec()
    const second = resolvedSpec()
    const dispose = installWindowVisibilitySubscriptionParking([first.spec, second.spec])
    await settle()

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS - 1)
    expect(first.unsubscribes[0]).not.toHaveBeenCalled()
    expect(second.unsubscribes[0]).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(first.unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(second.unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(first.currents[0]()).toBe(false)

    setDocumentVisibility('visible')
    await settle()
    expect(first.subscribe).toHaveBeenCalledTimes(2)
    expect(second.subscribe).toHaveBeenCalledTimes(2)
    expect(first.currents[0]()).toBe(false)
    expect(first.currents[1]()).toBe(true)

    dispose()
    expect(first.unsubscribes[1]).toHaveBeenCalledTimes(1)
    expect(second.unsubscribes[1]).toHaveBeenCalledTimes(1)
  })

  it('does not reconnect during a quick hide and show', async () => {
    const harness = resolvedSpec()
    const dispose = installWindowVisibilitySubscriptionParking([harness.spec])
    await settle()

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS - 1)
    setDocumentVisibility('visible')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)

    expect(harness.subscribe).toHaveBeenCalledTimes(1)
    expect(harness.unsubscribes[0]).not.toHaveBeenCalled()
    dispose()
  })

  it('widens the park delay after a quickly undone park and resets it after a long hide', async () => {
    const harness = resolvedSpec()
    const dispose = installWindowVisibilitySubscriptionParking([harness.spec])
    await settle()

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
    await settle()
    expect(harness.subscribe).toHaveBeenCalledTimes(2)

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    expect(harness.unsubscribes[1]).not.toHaveBeenCalled()

    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    expect(harness.unsubscribes[1]).toHaveBeenCalledTimes(1)

    const longHideMs =
      WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS *
      WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_BACKOFF_LIMIT
    vi.advanceTimersByTime(longHideMs)
    setDocumentVisibility('visible')
    await settle()
    expect(harness.subscribe).toHaveBeenCalledTimes(3)

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    expect(harness.unsubscribes[2]).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('reports each visibility generation before restarting its subscriptions', async () => {
    const first = resolvedSpec()
    const second = resolvedSpec()
    const onVisibilityResume = vi.fn()
    const dispose = installWindowVisibilitySubscriptionParking([first.spec, second.spec], {
      onVisibilityResume
    })
    await settle()

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
    await settle()

    expect(onVisibilityResume).toHaveBeenCalledWith({
      visibilityGeneration: 1,
      restartingSpecIndexes: [0, 1]
    })
    dispose()
  })

  it('paces resume starts in priority order and cancels delayed starts on cleanup', async () => {
    const first = resolvedSpec()
    const active = resolvedSpec()
    const third = resolvedSpec()
    const dispose = installWindowVisibilitySubscriptionParking(
      [first.spec, active.spec, third.spec],
      {
        getVisibilityResumePriority: (index) => (index === 1 ? 0 : 1),
        visibilityResumeStaggerMs: 50
      }
    )
    await settle()
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([1, 1, 1])

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
    await settle()
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([1, 2, 1])
    expect(vi.getTimerCount()).toBe(1)

    vi.advanceTimersByTime(50)
    await settle()
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([2, 2, 1])
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(50)
    await settle()
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([2, 2, 2])
    expect(vi.getTimerCount()).toBe(0)

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS * 2)
    setDocumentVisibility('visible')
    dispose()
    vi.advanceTimersByTime(100)
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([2, 3, 2])
  })

  it('cancels a paced chain when rehidden and restarts one new generation', async () => {
    const first = resolvedSpec()
    const active = resolvedSpec()
    const third = resolvedSpec()
    const parkDelayMs = 100
    const dispose = installWindowVisibilitySubscriptionParking(
      [first.spec, active.spec, third.spec],
      {
        getVisibilityResumePriority: (index) => (index === 1 ? 0 : 1),
        parkDelayMs,
        visibilityResumeStaggerMs: 1_000
      }
    )
    await settle()

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(parkDelayMs)
    setDocumentVisibility('visible')
    await settle()
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([1, 2, 1])

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(parkDelayMs)
    vi.advanceTimersByTime(5_000)
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([1, 2, 1])

    setDocumentVisibility('visible')
    await settle()
    vi.advanceTimersByTime(2_000)
    await settle()
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([2, 3, 2])
    dispose()
  })

  it('continues a paced chain when the priority subscription rejects', async () => {
    const first = resolvedSpec()
    const active = resolvedSpec()
    const third = resolvedSpec()
    const error = new Error('active start failed')
    const onSubscribeError = vi.fn()
    const dispose = installWindowVisibilitySubscriptionParking(
      [first.spec, { ...active.spec, onSubscribeError }, third.spec],
      {
        getVisibilityResumePriority: (index) => (index === 1 ? 0 : 1),
        visibilityResumeStaggerMs: 50
      }
    )
    await settle()
    active.subscribe.mockRejectedValueOnce(error)

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
    await settle()
    expect(onSubscribeError).toHaveBeenCalledWith(error)

    vi.advanceTimersByTime(100)
    await settle()
    expect(
      [first.subscribe, active.subscribe, third.subscribe].map((mock) => mock.mock.calls.length)
    ).toEqual([2, 2, 2])
    dispose()
  })

  it('stays parked when installed hidden and starts on reveal', async () => {
    setDocumentVisibility('hidden')
    const harness = resolvedSpec()
    const onVisibilityResume = vi.fn()
    const dispose = installWindowVisibilitySubscriptionParking([harness.spec], {
      onVisibilityResume
    })

    expect(harness.subscribe).not.toHaveBeenCalled()
    setDocumentVisibility('visible')
    await settle()
    expect(harness.subscribe).toHaveBeenCalledTimes(1)
    expect(onVisibilityResume).toHaveBeenCalledWith({
      visibilityGeneration: 1,
      restartingSpecIndexes: [0]
    })
    dispose()
  })

  it('restarts after input proves an already parked hidden document is stale', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const harness = resolvedSpec()
    const dispose = installWindowVisibilitySubscriptionParking([harness.spec])
    await settle()

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    expect(harness.unsubscribes[0]).toHaveBeenCalledTimes(1)

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    await settle()
    expect(document.visibilityState).toBe('hidden')
    expect(harness.subscribe).toHaveBeenCalledTimes(2)

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS * 2)
    expect(harness.unsubscribes[1]).toHaveBeenCalledTimes(1)
    dispose()
  })

  it('keeps one pending start and replaces it only after stale settlement', async () => {
    const first = createDeferred<{ unsubscribe: () => void }>()
    const second = createDeferred<{ unsubscribe: () => void }>()
    const firstUnsubscribe = vi.fn()
    const secondUnsubscribe = vi.fn()
    const currents: (() => boolean)[] = []
    const subscribe = vi
      .fn((isCurrent: () => boolean) => {
        currents.push(isCurrent)
        return first.promise
      })
      .mockImplementationOnce((isCurrent) => {
        currents.push(isCurrent)
        return first.promise
      })
      .mockImplementationOnce((isCurrent) => {
        currents.push(isCurrent)
        return second.promise
      })
    const dispose = installWindowVisibilitySubscriptionParking([{ subscribe }])

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    expect(currents[0]()).toBe(false)
    setDocumentVisibility('visible')
    expect(subscribe).toHaveBeenCalledTimes(1)

    first.resolve({ unsubscribe: firstUnsubscribe })
    await settle()
    expect(firstUnsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(2)
    expect(currents[0]()).toBe(false)
    expect(currents[1]()).toBe(true)

    second.resolve({ unsubscribe: secondUnsubscribe })
    await settle()
    dispose()
    expect(secondUnsubscribe).toHaveBeenCalledTimes(1)
  })

  it('retires a pending handle that resolves after permanent cleanup', async () => {
    const pending = createDeferred<{ unsubscribe: () => void }>()
    const unsubscribe = vi.fn()
    const subscribe = vi.fn(() => pending.promise)
    const dispose = installWindowVisibilitySubscriptionParking([{ subscribe }])

    dispose()
    pending.resolve({ unsubscribe })
    await settle()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('retries a rejected replacement while visible and cancels retries on cleanup', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const initialUnsubscribe = vi.fn()
    const replacementError = new Error('temporary reconnect failure')
    const subscribe = vi
      .fn<WindowVisibilitySubscriptionSpec['subscribe']>()
      .mockResolvedValueOnce({ unsubscribe: initialUnsubscribe })
      .mockRejectedValueOnce(replacementError)
      .mockResolvedValueOnce({ unsubscribe: vi.fn() })
      .mockRejectedValueOnce(replacementError)
    const onSubscribeError = vi.fn()
    const dispose = installWindowVisibilitySubscriptionParking([{ subscribe, onSubscribeError }])
    await settle()

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS)
    setDocumentVisibility('visible')
    await settle()
    expect(onSubscribeError).toHaveBeenCalledWith(replacementError)
    expect(subscribe).toHaveBeenCalledTimes(2)

    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS)
    await settle()
    expect(subscribe).toHaveBeenCalledTimes(3)

    setDocumentVisibility('hidden')
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_PARK_DELAY_MS * 2)
    setDocumentVisibility('visible')
    await settle()
    expect(subscribe).toHaveBeenCalledTimes(4)
    expect(subscribe.mock.calls.map(([, context]) => context.visibilityGeneration)).toEqual([
      0, 1, 1, 2
    ])
    dispose()
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS * 2)
    expect(subscribe).toHaveBeenCalledTimes(4)
  })

  it('isolates unsubscribe failures across entries', async () => {
    const onUnsubscribeError = vi.fn()
    const secondUnsubscribe = vi.fn()
    const first: WindowVisibilitySubscriptionSpec = {
      subscribe: async () => ({
        unsubscribe: () => {
          throw new Error('unsubscribe failed')
        }
      }),
      onUnsubscribeError
    }
    const second: WindowVisibilitySubscriptionSpec = {
      subscribe: async () => ({ unsubscribe: secondUnsubscribe })
    }
    const dispose = installWindowVisibilitySubscriptionParking([first, second])
    await settle()

    dispose()
    expect(onUnsubscribeError).toHaveBeenCalledOnce()
    expect(secondUnsubscribe).toHaveBeenCalledOnce()
  })
})
