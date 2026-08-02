import { describe, expect, it, vi } from 'vitest'
import {
  InFlightPromiseDedupe,
  MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES,
  MAX_IN_FLIGHT_PROMISE_DEDUPE_KEY_CODE_UNITS,
  stableInFlightKey
} from './in-flight-promise-dedupe'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

describe('InFlightPromiseDedupe', () => {
  it('coalesces only while in flight and retries after rejection', async () => {
    const dedupe = new InFlightPromiseDedupe<string>()
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error('transient failure'))
      .mockResolvedValueOnce('fresh')

    const key = stableInFlightKey(['diff', '/repo', 'src/file.ts', true])
    const first = dedupe.run(key, load)
    const second = dedupe.run(key, load)

    expect(first).toBe(second)
    await expect(first).rejects.toThrow('transient failure')
    expect(load).toHaveBeenCalledTimes(1)

    await expect(dedupe.run(key, load)).resolves.toBe('fresh')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('uses exact keys for distinct input parts', async () => {
    const dedupe = new InFlightPromiseDedupe<string>()
    const load = vi.fn(async () => 'value')

    await Promise.all([
      dedupe.run(stableInFlightKey(['diff', '/repo', 'src/file.ts', true]), load),
      dedupe.run(stableInFlightKey(['diff', '/repo', 'src/file.ts', false]), load)
    ])

    expect(load).toHaveBeenCalledTimes(2)
  })

  it('clears entries after synchronous loader failures', async () => {
    const dedupe = new InFlightPromiseDedupe<string>()
    const load = vi
      .fn<() => Promise<string> | string>()
      .mockImplementationOnce(() => {
        throw new Error('sync failure')
      })
      .mockResolvedValueOnce('fresh')

    const key = stableInFlightKey(['diff', '/repo', 'src/file.ts'])

    await expect(dedupe.run(key, () => Promise.resolve(load()))).rejects.toThrow('sync failure')
    await expect(dedupe.run(key, () => Promise.resolve(load()))).resolves.toBe('fresh')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('clear drops pending entries so later calls start fresh work', async () => {
    const dedupe = new InFlightPromiseDedupe<string>()
    const load = vi.fn<() => Promise<string>>()
    load.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce('fresh')

    const key = stableInFlightKey(['diff', '/repo', 'src/file.ts'])
    void dedupe.run(key, load)
    dedupe.clear()

    await expect(dedupe.run(key, load)).resolves.toBe('fresh')
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('expires hung entries so retries can start fresh work', async () => {
    vi.useFakeTimers()
    try {
      const dedupe = new InFlightPromiseDedupe<string>(5)
      const load = vi.fn<() => Promise<string>>()
      load.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce('fresh')

      const key = stableInFlightKey(['diff', '/repo', 'src/file.ts'])
      void dedupe.run(key, load)

      vi.advanceTimersByTime(5)

      await expect(dedupe.run(key, load)).resolves.toBe('fresh')
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('admits exactly the entry limit and bypasses new keys above it', async () => {
    const dedupe = new InFlightPromiseDedupe<string>()
    const pending = Array.from({ length: MAX_IN_FLIGHT_PROMISE_DEDUPE_ENTRIES }, () =>
      deferred<string>()
    )
    const admittedLoads = pending.map((item) => vi.fn(() => item.promise))

    for (let index = 0; index < pending.length; index += 1) {
      const first = dedupe.run(`key-${index}`, admittedLoads[index])
      const second = dedupe.run(`key-${index}`, admittedLoads[index])
      expect(second).toBe(first)
    }

    const overflowLoad = vi.fn(async () => 'overflow')
    const firstOverflow = dedupe.run('overflow', overflowLoad)
    const secondOverflow = dedupe.run('overflow', overflowLoad)
    expect(secondOverflow).not.toBe(firstOverflow)
    await expect(Promise.all([firstOverflow, secondOverflow])).resolves.toEqual([
      'overflow',
      'overflow'
    ])
    expect(overflowLoad).toHaveBeenCalledTimes(2)

    pending.forEach((item) => item.resolve('settled'))
    await Promise.all(pending.map((item) => item.promise))
  })

  it('admits a new key after a retained entry settles', async () => {
    const dedupe = new InFlightPromiseDedupe<string>(30_000, 1)
    const firstPending = deferred<string>()
    const first = dedupe.run('first', () => firstPending.promise)
    firstPending.resolve('first-result')
    await expect(first).resolves.toBe('first-result')

    const nextPending = deferred<string>()
    const load = vi.fn(() => nextPending.promise)
    const next = dedupe.run('next', load)
    expect(dedupe.run('next', load)).toBe(next)
    nextPending.resolve('next-result')
    await expect(next).resolves.toBe('next-result')
    expect(load).toHaveBeenCalledTimes(1)
  })

  it('keeps stable keys inline through the size limit and digests larger keys', () => {
    const exactInput = 'x'.repeat(MAX_IN_FLIGHT_PROMISE_DEDUPE_KEY_CODE_UNITS - 4)
    const oversizedInput = `${exactInput}x`

    expect(stableInFlightKey([exactInput])).toBe(JSON.stringify([exactInput]))
    const firstDigest = stableInFlightKey([oversizedInput])
    expect(firstDigest).toMatch(/^sha256:[a-f0-9]{64}$/)
    expect(stableInFlightKey([oversizedInput])).toBe(firstDigest)
    expect(stableInFlightKey([`${oversizedInput}x`])).not.toBe(firstDigest)
  })

  it('coalesces direct oversized keys through their bounded identity', async () => {
    const dedupe = new InFlightPromiseDedupe<string>()
    const pending = deferred<string>()
    const load = vi.fn(() => pending.promise)
    const oversizedKey = 'x'.repeat(MAX_IN_FLIGHT_PROMISE_DEDUPE_KEY_CODE_UNITS + 1)

    const first = dedupe.run(oversizedKey, load)
    expect(dedupe.run(oversizedKey, load)).toBe(first)
    pending.resolve('result')

    await expect(first).resolves.toBe('result')
    expect(load).toHaveBeenCalledTimes(1)
  })
})
