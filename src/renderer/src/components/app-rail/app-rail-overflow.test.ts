import { expect, it } from 'vitest'
import { partitionAppRail } from './app-rail-overflow'

it('always keeps the "…" slot (Customize or More) and never renders more slots than fit', () => {
  for (let destinations = 0; destinations <= 5; destinations++) {
    for (let capacity = 2; capacity <= 12; capacity++) {
      const partition = partitionAppRail(destinations, capacity)
      // Workspaces, the shown pages, the one "…" slot, then Help and Settings unless folded.
      const rendered =
        1 +
        partition.shownDestinations +
        1 +
        (partition.helpInMore ? 0 : 1) +
        (partition.settingsInMore ? 0 : 1)
      expect(rendered).toBeLessThanOrEqual(capacity)
      // Nothing folds while everything fits; once anything folds, the slot is More.
      const folded =
        partition.shownDestinations < destinations ||
        partition.helpInMore ||
        partition.settingsInMore
      expect(partition.more).toBe(folded)
    }
  }
})
