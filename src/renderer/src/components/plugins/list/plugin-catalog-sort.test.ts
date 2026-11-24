import { describe, expect, it } from 'vitest'
import { pluginCatalogComparators, type PluginCatalogSortEntry } from './plugin-catalog-sort'

function entry(
  pluginKey: string,
  options: { name?: string; addedAt?: string; updatedAt?: string } = {}
): PluginCatalogSortEntry {
  return {
    pluginKey,
    name: options.name ?? pluginKey,
    listing:
      options.addedAt !== undefined || options.updatedAt !== undefined
        ? { addedAt: options.addedAt, updatedAt: options.updatedAt }
        : null
  }
}

function sort(
  entries: PluginCatalogSortEntry[],
  comparator: keyof typeof pluginCatalogComparators
): string[] {
  return entries
    .sort((left, right) => pluginCatalogComparators[comparator](left, right, {}))
    .map(({ pluginKey }) => pluginKey)
}

describe('plugin catalog sorting', () => {
  it('sorts by install count, uses zero for missing counts, and breaks ties by plugin key', () => {
    const rows = [entry('z'), entry('b'), entry('a')]
    const counts = { z: 4, a: 4 }
    const compare = (left: PluginCatalogSortEntry, right: PluginCatalogSortEntry): number =>
      pluginCatalogComparators['most-installed'](left, right, counts)

    expect(rows.sort(compare).map(({ pluginKey }) => pluginKey)).toEqual(['a', 'z', 'b'])
  })

  it('sorts added dates descending, puts missing dates last, and breaks ties by plugin key', () => {
    expect(
      sort(
        [
          entry('z', { addedAt: '2025-01-01' }),
          entry('b'),
          entry('c', { addedAt: '2025-01-01' }),
          entry('a', { addedAt: '2026-01-01' })
        ],
        'recently-added'
      )
    ).toEqual(['a', 'c', 'z', 'b'])
  })

  it('sorts updated dates descending, puts missing dates last, and breaks ties by plugin key', () => {
    expect(
      sort(
        [
          entry('z', { updatedAt: '2025-01-01' }),
          entry('b'),
          entry('c', { updatedAt: '2025-01-01' }),
          entry('a', { updatedAt: '2026-01-01' })
        ],
        'recently-updated'
      )
    ).toEqual(['a', 'c', 'z', 'b'])
  })

  it('orders mixed timezone offsets by instant, not by string order', () => {
    // Why: listing dates come from many publishers; 01:00+02:00 is 23:00Z the day before.
    expect(
      sort(
        [
          entry('late', { updatedAt: '2026-01-01T01:00:00+02:00' }),
          entry('early', { updatedAt: '2026-01-01T00:00:00Z' }),
          entry('newest', { updatedAt: '2026-01-02T00:00:00+08:00' })
        ],
        'recently-updated'
      )
    ).toEqual(['newest', 'early', 'late'])
  })

  it('sorts names without regard to case, then breaks ties by plugin key', () => {
    expect(
      sort(
        [
          entry('z', { name: 'alpha' }),
          entry('b', { name: 'Alpha' }),
          entry('c', { name: 'Beta' })
        ],
        'name'
      )
    ).toEqual(['b', 'z', 'c'])
  })
})
