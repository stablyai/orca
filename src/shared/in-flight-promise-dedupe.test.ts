import { describe, expect, it, vi } from 'vitest'
import { InFlightPromiseDedupe, stableInFlightKey } from './in-flight-promise-dedupe'

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

    await expect(dedupe.run(key, load)).resolves.toBe('fresh')
  })

  it('clear drops pending entries so later calls start fresh work', async () => {
    const dedupe = new InFlightPromiseDedupe<string>()
    const load = vi.fn<() => Promise<string>>()
    load.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce('fresh')

    const key = stableInFlightKey(['diff', '/repo', 'src/file.ts'])
    void dedupe.run(key, load)
    dedupe.clear()

    await expect(dedupe.run(key, load)).resolves.toBe('fresh')
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
    } finally {
      vi.useRealTimers()
    }
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
  })
})
