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
})
