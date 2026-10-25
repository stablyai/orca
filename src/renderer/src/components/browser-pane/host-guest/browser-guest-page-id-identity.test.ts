import { describe, expect, it } from 'vitest'
import { collectBrowserPageIds } from './browser-guest-paint-retention'

describe('collectBrowserPageIds identity', () => {
  it('returns one shared reference for every empty input', () => {
    // No-browser worktrees are common; preserve the empty reference on every store write to avoid allocation.
    const fromUndefined = collectBrowserPageIds(undefined)

    expect(collectBrowserPageIds(null)).toBe(fromUndefined)
    expect(collectBrowserPageIds([])).toBe(fromUndefined)
    expect(fromUndefined).toEqual([])
  })
})
