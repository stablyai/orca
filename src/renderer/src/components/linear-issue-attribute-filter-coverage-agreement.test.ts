// Why: the pill and the in-section notice are the same claim in two places, so they must be
// driven by one predicate — a pill reading "partial" over a silent section is a real lie.
import { describe, expect, it } from 'vitest'
import { LinearFacetCoverageNotice } from './linear-issue-attribute-filter-coverage-notice'
import { isLinearMetadataGroupSelectionPartial } from './linear-issue-attribute-filter-team-ids'

function randomGroups(rng: () => number): { key: string; ids: string[] }[] {
  const count = 1 + Math.floor(rng() * 8)
  let next = 0
  return Array.from({ length: count }, (_unused, group) => ({
    key: `g${group}`,
    ids: Array.from({ length: 1 + Math.floor(rng() * 4) }, () => `id-${next++}`)
  }))
}

describe('coverage pill and notice agree', () => {
  it('shows the notice exactly when the pill reads partial', () => {
    let seed = 1337
    const rng = (): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }

    for (let run = 0; run < 20000; run += 1) {
      const groups = randomGroups(rng)
      const every = groups.flatMap((group) => group.ids)
      const selected = every.filter(() => rng() < 0.5)
      const truncated = rng() < 0.3
      const partial = isLinearMetadataGroupSelectionPartial(groups, selected, truncated)
      const notice = LinearFacetCoverageNotice({
        facet: 'status',
        options: groups,
        selectedIds: selected,
        max: 100,
        truncated
      })
      expect(notice === null).toBe(!partial)
    }
  })
})
