import { describe, expect, it } from 'vitest'
import { partitionAppRail } from './app-rail-overflow'

describe('partitionAppRail', () => {
  it('always keeps the "…" slot (Customize or More) and the account button, and never renders more slots than fit', () => {
    for (let destinations = 0; destinations <= 5; destinations++) {
      for (let capacity = 3; capacity <= 12; capacity++) {
        const partition = partitionAppRail(destinations, capacity)
        // Workspaces, the shown pages, the one "…" slot, then the account button, which never folds.
        const rendered = 1 + partition.shownDestinations + 1 + 1
        expect(rendered).toBeLessThanOrEqual(capacity)
        // Nothing folds while everything fits; once anything folds, the slot is More.
        expect(partition.more).toBe(partition.shownDestinations < destinations)
      }
    }
  })

  it('shows every destination, with "…" as Customize, when Workspaces, destinations, "…" and the account fit', () => {
    expect(partitionAppRail(5, 8)).toEqual({ shownDestinations: 5, more: false })
    expect(partitionAppRail(5, 20)).toEqual({ shownDestinations: 5, more: false })
  })

  it('folds destinations from the bottom into More, keeping Workspaces, More and the account button', () => {
    // 7 slots: Workspaces + More + account leave 4 for destinations.
    expect(partitionAppRail(5, 7)).toEqual({ shownDestinations: 4, more: true })
    expect(partitionAppRail(5, 5)).toEqual({ shownDestinations: 2, more: true })
  })

  it('never folds the account button, even when nothing else fits', () => {
    expect(partitionAppRail(5, 3)).toEqual({ shownDestinations: 0, more: true })
    expect(partitionAppRail(5, 0)).toEqual({ shownDestinations: 0, more: true })
  })

  it('keeps "…" as Customize when there are no destinations to fold', () => {
    expect(partitionAppRail(0, 0)).toEqual({ shownDestinations: 0, more: false })
    expect(partitionAppRail(0, 2)).toEqual({ shownDestinations: 0, more: false })
  })
})
