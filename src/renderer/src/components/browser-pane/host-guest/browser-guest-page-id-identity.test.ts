import { describe, expect, it } from 'vitest'
import { collectBrowserPageIds } from './browser-guest-paint-retention'

describe('collectBrowserPageIds identity', () => {
  it('returns one shared reference for every empty input', () => {
    // useWorktreeBrowserPageIds runs this on every store write, and a worktree with
    // no browser tabs is the common case; a fresh [] there is pure allocation.
    const fromUndefined = collectBrowserPageIds(undefined)

    expect(collectBrowserPageIds(null)).toBe(fromUndefined)
    expect(collectBrowserPageIds([])).toBe(fromUndefined)
    expect(fromUndefined).toEqual([])
  })

  it('still collects page ids, preferring pageIds over the active page', () => {
    const ids = collectBrowserPageIds([
      { id: 'tab-1', pageIds: ['page-a', 'page-b'] },
      { id: 'tab-2', activePageId: 'page-c' },
      { id: 'tab-3' }
    ])

    expect(ids).toEqual(['page-a', 'page-b', 'page-c', 'tab-3'])
  })

  it('falls back to the active page when pageIds is present but empty', () => {
    expect(collectBrowserPageIds([{ id: 'tab-1', pageIds: [], activePageId: 'page-a' }])).toEqual([
      'page-a'
    ])
  })
})
