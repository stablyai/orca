import { describe, expect, it, vi } from 'vitest'
import { InFlightPromiseDedupe, stableInFlightKey } from './in-flight-promise-dedupe'

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
})
