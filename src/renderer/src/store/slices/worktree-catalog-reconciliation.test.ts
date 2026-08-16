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
  it('caps the deep compares for one id instead of scanning the whole bucket', () => {
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
    expect(reads).toBeLessThanOrEqual(8)
    expect(reads).toBeLessThan(bucketSize)
  })
})
