import { describe, expect, it } from 'vitest'
import { createSingleFlightCoalescer } from './single-flight-coalescer'

/** Resolve after all queued microtasks and timers have drained. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

type Deferred = {
  promise: Promise<void>
  resolve: () => void
  reject: (e: unknown) => void
}
const deferred = (): Deferred => {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res()
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('createSingleFlightCoalescer', () => {
  it('runs the task immediately on the first request', async () => {
    let calls = 0
    const c = createSingleFlightCoalescer(async () => {
      calls++
    })
    c.request()
    await flush()
    expect(calls).toBe(1)
  })

  it('collapses a burst of requests during an in-flight run into ONE trailing run', async () => {
    // This is the #8539 wake-storm guard: K near-simultaneous reconnect triggers must
    // not produce K refreshes — only the leading run + a single trailing run.
    let calls = 0
    const gates: Deferred[] = []
    const c = createSingleFlightCoalescer(() => {
      calls++
      const d = deferred()
      gates.push(d)
      return d.promise
    })

    c.request() // leading run starts
    await flush()
    expect(calls).toBe(1)

    // 10 staggered reconnects land while the first refresh is still in flight.
    for (let i = 0; i < 10; i++) {
      c.request()
    }
    await flush()
    expect(calls).toBe(1) // still just the one in-flight run

    gates[0].resolve() // leading run settles -> exactly one trailing run
    await flush()
    expect(calls).toBe(2)

    gates[1].resolve() // trailing run settles; nothing pending
    await flush()
    expect(calls).toBe(2)
  })

  it('runs each request that arrives while idle (no coalescing without contention)', async () => {
    let calls = 0
    const c = createSingleFlightCoalescer(async () => {
      calls++
    })
    c.request()
    await flush()
    c.request()
    await flush()
    c.request()
    await flush()
    expect(calls).toBe(3)
  })

  it('chains multiple bursts: each in-flight window yields at most one trailing run', async () => {
    let calls = 0
    const gates: Deferred[] = []
    const c = createSingleFlightCoalescer(() => {
      calls++
      const d = deferred()
      gates.push(d)
      return d.promise
    })

    c.request()
    await flush()
    c.request() // pending during run 1
    gates[0].resolve()
    await flush()
    expect(calls).toBe(2) // trailing run 2 started
    c.request() // pending during run 2
    c.request()
    gates[1].resolve()
    await flush()
    expect(calls).toBe(3) // one trailing run 3
    gates[2].resolve()
    await flush()
    expect(calls).toBe(3)
  })

  it('does not wedge when the task throws synchronously', async () => {
    let calls = 0
    const c = createSingleFlightCoalescer(() => {
      calls++
      if (calls === 1) {
        throw new Error('sync boom')
      }
      return Promise.resolve()
    })
    c.request()
    await flush()
    expect(calls).toBe(1)
    // A later request must still run (inFlight was released despite the throw).
    c.request()
    await flush()
    expect(calls).toBe(2)
  })

  it('still runs the trailing run after a rejected task', async () => {
    let calls = 0
    const gates: Deferred[] = []
    const c = createSingleFlightCoalescer(() => {
      calls++
      const d = deferred()
      gates.push(d)
      return d.promise
    })
    c.request()
    await flush()
    c.request() // pending
    gates[0].reject(new Error('async boom'))
    await flush()
    expect(calls).toBe(2) // trailing run still fires
    gates[1].resolve()
    await flush()
  })
})
