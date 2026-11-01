import { describe, expect, it } from 'vitest'
import { reuseEqualCatalogRows } from './worktree-catalog-reconciliation'

describe('reuseEqualCatalogRows', () => {
  // Cap same-ID deep comparisons; count reads for deterministic O(k²) protection instead of flaky CI timing.
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
