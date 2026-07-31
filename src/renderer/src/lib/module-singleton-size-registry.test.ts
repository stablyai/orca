import { afterEach, describe, expect, it } from 'vitest'
import {
  _resetModuleSingletonSizesForTests,
  collectModuleSingletonSizes,
  registerModuleSingletonSize
} from './module-singleton-size-registry'

afterEach(() => {
  _resetModuleSingletonSizesForTests()
})

describe('collectModuleSingletonSizes', () => {
  it('reports live container sizes, not the size at registration time', () => {
    const cache = new Map<string, number>()
    registerModuleSingletonSize('runtime.cache', cache)

    expect(collectModuleSingletonSizes()).toEqual({})

    cache.set('a', 1)
    cache.set('b', 2)

    expect(collectModuleSingletonSizes()).toEqual({ 'runtime.cache': 2 })
  })

  it('reads Maps and Sets alike, plus derived numeric sources', () => {
    registerModuleSingletonSize('m', new Map([['a', 1]]))
    registerModuleSingletonSize('s', new Set([1, 2, 3]))
    registerModuleSingletonSize('derived', () => 42.6)

    expect(collectModuleSingletonSizes()).toEqual({ m: 1, s: 3, derived: 43 })
  })

  it('contains a throwing source instead of losing the other counts', () => {
    registerModuleSingletonSize('broken', () => {
      throw new Error('boom')
    })
    registerModuleSingletonSize('healthy', new Set([1, 2]))

    expect(collectModuleSingletonSizes()).toEqual({ 'broken.error': 1, healthy: 2 })
  })

  it('skips non-finite sizes rather than emitting junk fields', () => {
    registerModuleSingletonSize('nan', () => Number.NaN)
    registerModuleSingletonSize('infinite', () => Number.POSITIVE_INFINITY)
    registerModuleSingletonSize('real', () => 5)

    expect(collectModuleSingletonSizes()).toEqual({ real: 5 })
  })

  it('unregisters cleanly and does not clobber a re-registered name', () => {
    const dispose = registerModuleSingletonSize('a', new Set([1]))
    registerModuleSingletonSize('a', new Set([1, 2]))

    // The stale disposer must not remove the newer registration.
    dispose()

    expect(collectModuleSingletonSizes()).toEqual({ a: 2 })
  })

  it('refuses registrations past the cap so one module cannot crowd out the rest', () => {
    for (let index = 0; index < 32; index += 1) {
      registerModuleSingletonSize(`s${index}`, new Set([1]))
    }
    registerModuleSingletonSize('overflow', new Set([1, 2, 3]))

    const counts = collectModuleSingletonSizes()

    expect(Object.keys(counts)).toHaveLength(32)
    expect(counts.overflow).toBeUndefined()
  })

  it('rejects an oversized name that would blow the breadcrumb key budget', () => {
    registerModuleSingletonSize('x'.repeat(49), new Set([1]))

    expect(collectModuleSingletonSizes()).toEqual({})
  })

  it('returns a no-op disposer for a rejected registration', () => {
    registerModuleSingletonSize('kept', new Set([1]))
    const rejected = registerModuleSingletonSize('', new Set([1]))

    expect(() => rejected()).not.toThrow()
    expect(collectModuleSingletonSizes()).toEqual({ kept: 1 })
  })
})

describe('production wiring', () => {
  // No reset here: the assertion depends on the module's own top-level
  // registration, which is the thing under test.
  it('registers the watchdog PTY table, and its count tracks real activity', async () => {
    const watchdog =
      await import('../components/terminal-pane/terminal-delivery-watchdog-size-registry')
    const read = (): number | undefined =>
      collectModuleSingletonSizes()['watchdog.receivedPtyCharTotals']

    // Empty registrations are skipped, so a real count is what proves the wiring.
    expect(read()).toBeUndefined()
    try {
      watchdog.receivedPtyCharTotals.set('pty-a', 12)
      watchdog.receivedPtyCharTotals.set('pty-b', 34)

      expect(read()).toBe(2)
    } finally {
      watchdog.receivedPtyCharTotals.delete('pty-a')
      watchdog.receivedPtyCharTotals.delete('pty-b')
    }

    expect(read()).toBeUndefined()
  })
})
