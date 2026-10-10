// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resetStaleDocumentVisibilityForTesting } from '@/components/terminal-pane/stale-document-visibility'
import {
  installWindowVisibilitySubscriptionParking,
  WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS,
  type WindowVisibilitySubscriptionContext
} from './window-visibility-subscription-parking'

/** #21052/#19092: a host-ended stream must come back, but never faster than the retry backoff. */
function endableSpec() {
  const contexts: WindowVisibilitySubscriptionContext[] = []
  const currents: (() => boolean)[] = []
  const unsubscribes: ReturnType<typeof vi.fn>[] = []
  const subscribe = vi.fn(
    async (isCurrent: () => boolean, context: WindowVisibilitySubscriptionContext) => {
      currents.push(isCurrent)
      contexts.push(context)
      const unsubscribe = vi.fn()
      unsubscribes.push(unsubscribe)
      return { unsubscribe }
    }
  )
  return { contexts, currents, spec: { subscribe }, subscribe, unsubscribes }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

// The retry jitter is at most 250ms.
const JITTER_MS = 250

describe('a stream the host ends while the window stays visible', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(Math, 'random').mockReturnValue(0)
  })

  afterEach(() => {
    resetStaleDocumentVisibilityForTesting()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('drops the ended stream and resubscribes after the backoff', async () => {
    const stream = endableSpec()
    const dispose = installWindowVisibilitySubscriptionParking([stream.spec])
    await settle()
    expect(stream.subscribe).toHaveBeenCalledTimes(1)

    stream.contexts[0]!.ended()

    expect(stream.unsubscribes[0]).toHaveBeenCalledTimes(1)
    expect(stream.currents[0]!()).toBe(false)
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS - 1)
    expect(stream.subscribe).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await settle()
    expect(stream.subscribe).toHaveBeenCalledTimes(2)
    expect(stream.currents[1]!()).toBe(true)
    dispose()
  })

  it('backs off across repeated short-lived streams instead of looping', async () => {
    const stream = endableSpec()
    const dispose = installWindowVisibilitySubscriptionParking([stream.spec])
    await settle()

    const delays: number[] = []
    for (let attempt = 0; attempt < 4; attempt += 1) {
      stream.contexts.at(-1)!.ended()
      const before = stream.subscribe.mock.calls.length
      let waited = 0
      while (stream.subscribe.mock.calls.length === before) {
        vi.advanceTimersByTime(100)
        waited += 100
        await settle()
      }
      delays.push(waited)
    }

    expect(delays).toEqual([1_000, 2_000, 4_000, 8_000])
    dispose()
  })

  it('ignores a second end from the same stream and an end after disposal', async () => {
    const stream = endableSpec()
    const dispose = installWindowVisibilitySubscriptionParking([stream.spec])
    await settle()
    const ended = stream.contexts[0]!.ended

    ended()
    ended()
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS + JITTER_MS)
    await settle()
    expect(stream.subscribe).toHaveBeenCalledTimes(2)

    dispose()
    stream.contexts[1]!.ended()
    vi.advanceTimersByTime(60_000)
    await settle()
    expect(stream.subscribe).toHaveBeenCalledTimes(2)
  })

  it('unsubscribes a stream that ends before its subscribe settles', async () => {
    let resolveHandle = (_handle: { unsubscribe: () => void }): void => {}
    const unsubscribe = vi.fn()
    const contexts: WindowVisibilitySubscriptionContext[] = []
    const subscribe = vi
      .fn()
      .mockImplementationOnce(
        (_isCurrent: () => boolean, context: WindowVisibilitySubscriptionContext) => {
          contexts.push(context)
          return new Promise((resolve) => {
            resolveHandle = resolve
          })
        }
      )
      .mockResolvedValue({ unsubscribe: vi.fn() })
    const dispose = installWindowVisibilitySubscriptionParking([{ subscribe }])

    contexts[0]!.ended()
    resolveHandle({ unsubscribe })
    await settle()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(subscribe).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(WINDOW_VISIBILITY_SUBSCRIPTION_RETRY_INITIAL_MS)
    await settle()
    expect(subscribe).toHaveBeenCalledTimes(2)
    dispose()
  })
})
