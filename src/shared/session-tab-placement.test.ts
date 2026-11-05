import { describe, expect, it } from 'vitest'
import { placeCreatedSessionTab } from './session-tab-placement'

const created = { id: 'new' }

describe('placeCreatedSessionTab', () => {
  it('inserts after all leaves of a split parent', () => {
    expect(
      placeCreatedSessionTab(
        [
          { id: 'split::left', parentTabId: 'split' },
          { id: 'split::right', parentTabId: 'split' },
          { id: 'trailing' }
        ],
        { id: 'new' },
        'split::left',
        { afterParentGroup: true }
      ).map((tab) => tab.id)
    ).toEqual(['split::left', 'split::right', 'new', 'trailing'])
  })

  it('keeps legacy leaf placement when split grouping is not negotiated', () => {
    expect(
      placeCreatedSessionTab(
        [
          { id: 'split::left', parentTabId: 'split' },
          { id: 'split::right', parentTabId: 'split' },
          { id: 'trailing' }
        ],
        { id: 'new' },
        'split::left'
      ).map((tab) => tab.id)
    ).toEqual(['split::left', 'new', 'split::right', 'trailing'])
  })

  it('finds split siblings after an interleaved tab', () => {
    expect(
      placeCreatedSessionTab(
        [
          { id: 'split::left', parentTabId: 'split' },
          { id: 'trailing' },
          { id: 'split::right', parentTabId: 'split' }
        ],
        { id: 'new' },
        'split::left',
        { afterParentGroup: true }
      ).map((tab) => tab.id)
    ).toEqual(['split::left', 'trailing', 'split::right', 'new'])
  })

  it('appends when the anchor is absent', () => {
    expect(
      placeCreatedSessionTab([{ id: 'a' }, { id: 'b' }], created, 'missing').map((t) => t.id)
    ).toEqual(['a', 'b', 'new'])
  })

  it('re-places a tab that is already in the list instead of duplicating it', () => {
    expect(
      placeCreatedSessionTab([{ id: 'a' }, { id: 'new' }, { id: 'b' }], created, 'b').map(
        (t) => t.id
      )
    ).toEqual(['a', 'b', 'new'])
  })
})
