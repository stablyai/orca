import { describe, expect, it } from 'vitest'
import { catalogRowsEqual, reuseEqualCatalogRows } from './worktree-catalog-reconciliation'

describe('reuseEqualCatalogRows', () => {
  it('does not traverse a catalog already reconciled by identity', () => {
    const current = [
      {
        get id(): string {
          throw new Error('catalog row was traversed')
        }
      }
    ]

    expect(catalogRowsEqual(current, current)).toBe(true)
  })

  it('reuses rows with equivalent nested catalog data', () => {
    const current = [
      { id: 'a', nested: { labels: ['one', 'two'] }, optional: undefined },
      { id: 'b', nested: { labels: ['three'] } }
    ]
    const incoming = [
      { id: 'a', nested: { labels: ['one', 'two'] } },
      { id: 'b', nested: { labels: ['three'] } }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).toBe(current)
    expect(catalogRowsEqual(current, incoming)).toBe(true)
  })

  it('reuses unaffected rows while publishing nested changes', () => {
    const current = [
      { id: 'a', nested: { value: 1 } },
      { id: 'b', nested: { value: 2 } }
    ]
    const incoming = [
      { id: 'a', nested: { value: 3 } },
      { id: 'b', nested: { value: 2 } }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).not.toBe(current)
    expect(reconciled[0]).toBe(incoming[0])
    expect(reconciled[1]).toBe(current[1])
  })

  it('does not hide host ownership changes', () => {
    const current = [{ id: 'a', runtimeOwnerEnvironmentId: 'env-a' }]
    const incoming = [{ id: 'a', runtimeOwnerEnvironmentId: 'env-b' }]

    expect(reuseEqualCatalogRows(current, incoming)[0]).toBe(incoming[0])
  })

  it('reuses same-ID rows from different hosts independently', () => {
    const current = [
      { id: 'repo::/same/path', hostId: 'ssh:a' },
      { id: 'repo::/same/path', hostId: 'ssh:b' }
    ]
    const equivalent = structuredClone(current)

    expect(reuseEqualCatalogRows(current, equivalent)).toBe(current)

    const incoming = structuredClone(current.toReversed())
    const reconciled = reuseEqualCatalogRows(current, incoming)

    expect(reconciled).not.toBe(current)
    expect(reconciled.map((row) => row.hostId)).toEqual(['ssh:b', 'ssh:a'])
    expect(reconciled[0]).toBe(current[1])
    expect(reconciled[1]).toBe(current[0])
  })

  it('reuses a match inside the duplicate-id scan window', () => {
    const current = [
      { id: 'dup', marker: 'a' },
      { id: 'dup', marker: 'b' },
      { id: 'dup', marker: 'c' }
    ]

    const reconciled = reuseEqualCatalogRows(current, [{ id: 'dup', marker: 'c' }])

    expect(reconciled[0]).toBe(current[2])
  })

  // Without the cap this walks the whole bucket, so a 64-row bucket costs 64
  // deep compares per incoming row. Counting reads keeps the guard deterministic
  // — a wall-clock assertion would be flaky on shared CI runners.
  // The cap this replaced gave up matches past its window. The index does not:
  // a match at the far end of a large bucket is reused again.
  it('reuses a match at the far end of a large duplicate-id bucket', () => {
    const bucketSize = 64
    const current = Array.from({ length: bucketSize }, (_, index) => ({
      id: 'dup',
      marker: `previous-${index}`
    }))

    const reconciled = reuseEqualCatalogRows(current, [{ id: 'dup', marker: 'previous-63' }])

    expect(reconciled[0]).toBe(current[63])
  })

  it('consumes each previous row at most once across a large bucket', () => {
    const current = Array.from({ length: 32 }, () => ({ id: 'dup', marker: 'same' }))

    const reconciled = reuseEqualCatalogRows(current, [
      { id: 'dup', marker: 'same' },
      { id: 'dup', marker: 'same' }
    ])

    expect(reconciled[0]).toBe(current[0])
    expect(reconciled[1]).toBe(current[1])
    expect(reconciled[0]).not.toBe(reconciled[1])
  })

  // JSON collapses distinctions the equality walk keeps, so a fingerprint group
  // can hold rows that are not actually equal. Rejecting one must not consume it.
  it('keeps a rejected same-fingerprint candidate available to later rows', () => {
    const instants = Array.from({ length: 16 }, () => new Date(0))
    const current = instants.map((at) => ({ id: 'dup', at }))

    const reconciled = reuseEqualCatalogRows(current, [
      { id: 'dup', at: instants[1] as Date },
      { id: 'dup', at: instants[0] as Date }
    ])

    // Distinct Date objects share a fingerprint but are not structurally equal,
    // so resolving the first row must leave the second row's match in place.
    expect(reconciled[0]).toBe(current[1])
    expect(reconciled[1]).toBe(current[0])
  })

  // Leaving rejected candidates in place is only affordable because the group
  // scan is itself capped, and nothing else in this suite fails if that cap is
  // dropped. Assert the confirms do not SCALE with the group — an absolute bound
  // would pin the threshold constant instead, which is a tuning knob.
  it('bounds the confirms inside an all-colliding fingerprint group', () => {
    const confirmsFor = (groupSize: number): number => {
      // One fingerprint, no two rows structurally equal: distinct Date objects.
      const current = Array.from({ length: groupSize }, () => ({ id: 'dup', at: new Date(0) }))
      let reads = 0
      const incoming = [
        {
          id: 'dup',
          get at(): Date {
            reads++
            return new Date(0)
          }
        }
      ]

      expect(reuseEqualCatalogRows(current as never, incoming as never)[0]).toBe(incoming[0])
      return reads
    }

    expect(confirmsFor(400)).toBe(confirmsFor(50))
  })

  it('still matches when a large bucket cannot be fingerprinted', () => {
    // JSON.stringify throws on BigInt, so the index cannot be built and this
    // falls back to the capped scan rather than crashing or losing the match.
    const row = (marker: string): Record<string, unknown> => ({ id: 'dup', marker, size: 1n })
    const current = Array.from({ length: 16 }, (_, index) => row(`previous-${index}`))

    const reconciled = reuseEqualCatalogRows(current as never, [row('previous-0')] as never)

    expect(reconciled[0]).toBe(current[0])
  })

  it('keeps the deep compares off the whole bucket', () => {
    const bucketSize = 64
    const current = Array.from({ length: bucketSize }, (_, index) => ({
      id: 'dup',
      marker: `previous-${index}`
    }))
    let reads = 0
    const incoming = [
      {
        id: 'dup',
        get marker(): string {
          reads++
          return 'matches-nothing'
        }
      }
    ]

    const reconciled = reuseEqualCatalogRows(current, incoming)

    // No match, so the incoming row is kept — a missed reuse costs identity, never correctness.
    expect(reconciled[0]).toBe(incoming[0])
    expect(reads).toBeLessThan(bucketSize)
  })
})
