import { describe, expect, it } from 'vitest'
import { collectBrowserPageIds } from './browser-guest-paint-retention'

describe('collectBrowserPageIds', () => {
  it('prefers the full page list so every guest under a tab is covered', () => {
    expect(
      collectBrowserPageIds([
        { id: 'tab-1', activePageId: 'page-a', pageIds: ['page-a', 'page-b'] }
      ])
    ).toEqual(['page-a', 'page-b'])
  })

  // Why: a split tab can hold a background page a phone is driving while a different page is
  // active; collecting only the active one would let that guest get parked.
  it('does not drop background pages in favour of the active one', () => {
    expect(
      collectBrowserPageIds([{ id: 't', activePageId: 'p1', pageIds: ['p1', 'p2'] }])
    ).toContain('p2')
  })

  it('falls back to the active page id when the list is empty', () => {
    expect(collectBrowserPageIds([{ id: 'tab-1', activePageId: 'page-a', pageIds: [] }])).toEqual([
      'page-a'
    ])
  })

  // Why: legacy single-page tabs reuse the tab id as the page id.
  it('falls back to the tab id when there is no active page', () => {
    expect(collectBrowserPageIds([{ id: 'tab-1' }])).toEqual(['tab-1'])
    expect(collectBrowserPageIds([{ id: 'tab-1', activePageId: null }])).toEqual(['tab-1'])
  })

  it('tolerates a missing worktree entry', () => {
    expect(collectBrowserPageIds(undefined)).toEqual([])
    expect(collectBrowserPageIds(null)).toEqual([])
  })

  it('flattens across tabs', () => {
    expect(
      collectBrowserPageIds([
        { id: 'tab-1', pageIds: ['a'] },
        { id: 'tab-2', pageIds: ['b', 'c'] }
      ])
    ).toEqual(['a', 'b', 'c'])
  })
})
