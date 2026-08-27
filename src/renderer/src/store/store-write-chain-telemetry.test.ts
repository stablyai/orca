/**
 * The synthetic ring below reproduces the #185 shape with no field repro: an
 * innocent dispatch triggers a subscriber that chains writes past the
 * threshold. The captured stack must name the chaining subscriber (the
 * driver), not the initial dispatcher — the opposite of what React's own
 * throw reports.
 */
import { describe, expect, it, vi } from 'vitest'
import { createStore, type StoreApi } from 'zustand/vanilla'
import {
  createStoreWriteChainTelemetry,
  installStoreWriteChainTelemetry,
  STORE_WRITE_CHAIN_CAPTURE_INTERVAL_MS,
  STORE_WRITE_CHAIN_STACK_THRESHOLD
} from './store-write-chain-telemetry'
import { STORE_WRITE_CHAIN_BREADCRUMB } from '../../../shared/store-write-chain-diagnostics'

type RingState = { n: number }

type InstallOptions = Parameters<typeof installStoreWriteChainTelemetry>[1]

function createInstrumentedStore(options?: InstallOptions): StoreApi<RingState> {
  const api = createStore<RingState>(() => ({ n: 0 }))
  installStoreWriteChainTelemetry(api, options)
  return api
}

/** Named so the captured stack can be asserted to contain this frame. */
function driverEffectLoopWrite(
  api: { getState: () => RingState; setState: (p: RingState) => void },
  ceiling: number
): void {
  const { n } = api.getState()
  if (n < ceiling) {
    api.setState({ n: n + 1 })
  }
}

/** Named so the captured stack can be asserted to NOT contain this frame. */
function innocentBystanderDispatch(api: { setState: (p: RingState) => void }): void {
  api.setState({ n: 1 })
}

/** Benign bulk work (e.g. close-other-tabs) that legitimately crosses the
 *  threshold in one flush; named so its stack can be told from the ring's. */
function benignBulkTabCloseDispatch(
  api: { setState: (p: RingState) => void },
  writes: number
): void {
  for (let i = 0; i < writes; i += 1) {
    api.setState({ n: i })
  }
}

async function yieldMicrotasks(): Promise<void> {
  // Why: the depth reset is a queueMicrotask scheduled by the burst's first
  // write, so one drained microtask tick is a genuine yield.
  await Promise.resolve()
}

describe('store write chain telemetry', () => {
  it('names the chaining driver, not the dispatch that merely started the flush', () => {
    const record = vi.fn()
    const api = createInstrumentedStore({ record })
    api.subscribe(() => driverEffectLoopWrite(api, 60))

    innocentBystanderDispatch(api)

    expect(record).toHaveBeenCalledTimes(1)
    const [name, data] = record.mock.calls[0] as [string, Record<string, unknown>]
    expect(name).toBe(STORE_WRITE_CHAIN_BREADCRUMB)
    expect(data.depth).toBe(STORE_WRITE_CHAIN_STACK_THRESHOLD)
    const stack = String(data.stack)
    expect(stack).toContain('driverEffectLoopWrite')
    // The bystander sits ~24 chained hops below the capture; the raised frame
    // budget reaches the ring, not the bottom of the stack — exactly the
    // attribution React's bystander-blaming throw cannot make.
    expect(stack).not.toContain('innocentBystanderDispatch')
    // The default V8 budget of 10 frames would show only wrapper plumbing.
    expect(stack.split('\n').length).toBeGreaterThan(12)
  })

  it('captures nothing when writes stay below the threshold', () => {
    const record = vi.fn()
    const captureStack = vi.fn(() => 'stack')
    const api = createInstrumentedStore({ record, captureStack })

    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD - 1; i += 1) {
      api.setState({ n: i })
    }

    expect(captureStack).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
  })

  it('does not construct an Error on the normal write path', () => {
    const record = vi.fn()
    const api = createInstrumentedStore({ record })
    const errorSpy = vi.spyOn(globalThis, 'Error')
    try {
      for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD - 1; i += 1) {
        api.setState({ n: i })
      }
      expect(errorSpy).not.toHaveBeenCalled()

      api.setState({ n: STORE_WRITE_CHAIN_STACK_THRESHOLD })
      expect(errorSpy).toHaveBeenCalledTimes(1)
    } finally {
      errorSpy.mockRestore()
    }
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('restores Error.stackTraceLimit after a capture', () => {
    const record = vi.fn()
    const api = createInstrumentedStore({ record })
    const originalLimit = Error.stackTraceLimit
    try {
      // Why pin: an earlier capture that leaked the raised limit would
      // otherwise become the "previous" value and hide a missing restore.
      Error.stackTraceLimit = 7

      for (let i = 0; i <= STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
        api.setState({ n: i })
      }

      expect(record).toHaveBeenCalledTimes(1)
      expect(Error.stackTraceLimit).toBe(7)
    } finally {
      Error.stackTraceLimit = originalLimit
    }
  })

  it('resets the depth counter when the app genuinely yields', async () => {
    const record = vi.fn()
    const api = createInstrumentedStore({ record })
    // Two bursts that only cross the threshold if a missing reset lets them sum.
    const subThresholdBurst = STORE_WRITE_CHAIN_STACK_THRESHOLD - 5

    for (let i = 0; i < subThresholdBurst; i += 1) {
      api.setState({ n: i })
    }
    await yieldMicrotasks()
    for (let i = 0; i < subThresholdBurst; i += 1) {
      api.setState({ n: 100 + i })
    }
    expect(record).not.toHaveBeenCalled()

    await yieldMicrotasks()
    // The counter must still be armed after resets: a real same-flush chain
    // crosses the threshold as if the earlier bursts never happened.
    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
      api.setState({ n: 200 + i })
    }
    expect(record).toHaveBeenCalledTimes(1)
  })

  it('captures once per burst even when the chain runs far past the threshold', () => {
    const record = vi.fn()
    // Why interval 0: the equality latch must bound the burst on its own, so
    // the capture-frequency floor cannot mask a broken latch here.
    const api = createInstrumentedStore({ record, captureIntervalMs: 0 })

    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD * 3; i += 1) {
      api.setState({ n: i })
    }

    expect(record).toHaveBeenCalledTimes(1)
  })

  it('floors capture frequency but keeps counting skipped bursts', async () => {
    const record = vi.fn()
    let nowMs = 0
    const api = createInstrumentedStore({ record, now: () => nowMs })
    const runBurst = (): void => {
      for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
        api.setState({ n: Math.random() })
      }
    }

    runBurst()
    await yieldMicrotasks()
    nowMs += STORE_WRITE_CHAIN_CAPTURE_INTERVAL_MS - 1
    runBurst()
    await yieldMicrotasks()
    expect(record).toHaveBeenCalledTimes(1)

    nowMs += STORE_WRITE_CHAIN_CAPTURE_INTERVAL_MS
    runBurst()
    expect(record).toHaveBeenCalledTimes(2)
    const [, data] = record.mock.calls[1] as [string, Record<string, unknown>]
    // The skipped burst stays visible as a delta between captured crumbs.
    expect(data.burstsSinceInstall).toBe(3)
  })

  it('sums a cascade across stores sharing one tracker', () => {
    const record = vi.fn()
    const tracker = createStoreWriteChainTelemetry({ record })
    const storeA = createStore<RingState>(() => ({ n: 0 }))
    const storeB = createStore<RingState>(() => ({ n: 0 }))
    tracker.install(storeA)
    tracker.install(storeB)

    // Alternate writes so each store alone stays well under the threshold —
    // only the shared counter sees the combined chain cross it.
    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD; i += 1) {
      ;(i % 2 === 0 ? storeA : storeB).setState({ n: i })
    }

    expect(record).toHaveBeenCalledTimes(1)
    const [, data] = record.mock.calls[0] as [string, Record<string, unknown>]
    expect(data.depth).toBe(STORE_WRITE_CHAIN_STACK_THRESHOLD)
  })

  it('pins the threshold to half the React nested-update limit', () => {
    // (1+k)·(T−1) ≤ 50 for k non-store commits per store write: T=25 keeps
    // the capture ahead of the throw for mixed rings up to k=1 (2·24 = 48).
    // Raising T silently gives that coverage back — see the constant's doc.
    expect(STORE_WRITE_CHAIN_STACK_THRESHOLD).toBe(25)
  })

  it('a deeper ring inside the capture floor supersedes an earlier benign burst', async () => {
    const record = vi.fn()
    let nowMs = 0
    const api = createInstrumentedStore({ record, now: () => nowMs })

    // Routine bulk close: 26 writes, one flush — crosses the threshold at t=0.
    benignBulkTabCloseDispatch(api, STORE_WRITE_CHAIN_STACK_THRESHOLD + 1)
    await yieldMicrotasks()

    // A REAL ring 8s later, still inside the 10s floor window.
    nowMs += 8_000
    api.subscribe(() => driverEffectLoopWrite(api, 50))
    innocentBystanderDispatch(api)
    await yieldMicrotasks()

    // The surviving record must name the ring driver, not the bulk close that
    // merely got there first — otherwise the crash blames a bystander.
    const [, data] = record.mock.calls.at(-1) as [string, Record<string, unknown>]
    const stack = String(data.stack)
    expect(stack).toContain('driverEffectLoopWrite')
    expect(stack).not.toContain('benignBulkTabCloseDispatch')
    expect(data.depth).toBe(50)
  })

  it('stamps the burst-end depth so benign bursts stay tellable from true rings', async () => {
    const record = vi.fn()
    const api = createInstrumentedStore({ record })

    benignBulkTabCloseDispatch(api, STORE_WRITE_CHAIN_STACK_THRESHOLD + 7)
    await yieldMicrotasks()

    // Threshold-crossing depth alone reads 25 for every burst; the burst-end
    // depth is the discriminator (a benign batch ends near the threshold, a
    // #185-bound ring runs toward React's limit of 50).
    const [, data] = record.mock.calls.at(-1) as [string, Record<string, unknown>]
    expect(data.depth).toBe(STORE_WRITE_CHAIN_STACK_THRESHOLD + 7)
    expect(data.depthAtCapture).toBe(STORE_WRITE_CHAIN_STACK_THRESHOLD)
  })

  it('shallower bursts inside the window neither capture nor overwrite a deeper record', async () => {
    const record = vi.fn()
    const captureStack = vi.fn(() => 'ring stack')
    let nowMs = 0
    const api = createInstrumentedStore({ record, captureStack, now: () => nowMs })

    // Deep burst first: the window's record to beat.
    benignBulkTabCloseDispatch(api, 50)
    await yieldMicrotasks()
    const recordsAfterDeepBurst = record.mock.calls.length

    // A storm of shallower threshold-crossing bursts inside the same window
    // must stay free: no stack capture, no record churn (reverse masking).
    for (let burst = 0; burst < 3; burst += 1) {
      nowMs += 1_000
      benignBulkTabCloseDispatch(api, STORE_WRITE_CHAIN_STACK_THRESHOLD + 1)
      await yieldMicrotasks()
    }

    expect(captureStack).toHaveBeenCalledTimes(1)
    expect(record.mock.calls.length).toBe(recordsAfterDeepBurst)
  })

  it('never blocks or alters writes, even when recording fails', () => {
    const api = createInstrumentedStore({
      record: () => {
        throw new Error('recorder down')
      }
    })

    for (let i = 0; i < STORE_WRITE_CHAIN_STACK_THRESHOLD + 5; i += 1) {
      api.setState({ n: i })
    }
    expect(api.getState().n).toBe(STORE_WRITE_CHAIN_STACK_THRESHOLD + 4)

    // Updater-function writes pass through unchanged too.
    api.setState((state) => ({ n: state.n + 1 }))
    expect(api.getState().n).toBe(STORE_WRITE_CHAIN_STACK_THRESHOLD + 5)
  })
})
