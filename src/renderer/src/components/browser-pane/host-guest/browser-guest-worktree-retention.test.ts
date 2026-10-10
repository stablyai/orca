import { describe, expect, it } from 'vitest'
import type { BrowserPage, BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import {
  BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT,
  browserTabVisibilityPageIds,
  selectBrowserGuestEvictionWorktreeIds,
  touchBrowserGuestWorktreeRecency,
  worktreeHoldsLiveBrowserGuests
} from './browser-guest-worktree-retention'

function browserTab(
  id: string,
  pageIds: string[] = [],
  activePageId: string | null = null
): BrowserWorkspace {
  return {
    id,
    worktreeId: 'wt-1',
    label: id,
    sessionProfileId: null,
    pageIds,
    activePageId,
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

function page(id: string, workspaceId: string): BrowserPage {
  return {
    id,
    workspaceId,
    worktreeId: 'wt-1',
    url: 'about:blank',
    title: id,
    loading: false,
    faviconUrl: null,
    canGoBack: false,
    canGoForward: false,
    loadError: null,
    createdAt: 1
  }
}

type SelectionOverrides = Partial<Parameters<typeof selectBrowserGuestEvictionWorktreeIds>[0]>

function selectEvicted(overrides: SelectionOverrides): string[] {
  return selectBrowserGuestEvictionWorktreeIds({
    orderedWorktreeIds: [],
    activeWorktreeId: null,
    isRetained: () => true,
    holdsLiveGuests: () => true,
    isEvictable: () => true,
    ...overrides
  })
}

describe('selectBrowserGuestEvictionWorktreeIds', () => {
  const sixWorktrees = ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-5', 'wt-6']

  it('is a no-op while retained guest-holding worktrees fit the budget', () => {
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees.slice(0, BROWSER_GUEST_HIDDEN_WORKTREE_RETENTION_LIMIT)
      })
    ).toEqual([])
  })

  it('evicts the least-recently-activated worktrees beyond the budget', () => {
    expect(selectEvicted({ orderedWorktreeIds: sixWorktrees })).toEqual(['wt-5', 'wt-6'])
  })

  it('never evicts or counts the active worktree', () => {
    // Active most-recent: five hidden holders remain, so only the LRU one goes.
    expect(selectEvicted({ orderedWorktreeIds: sixWorktrees, activeWorktreeId: 'wt-1' })).toEqual([
      'wt-6'
    ])
    // Active in LRU position: it is spared even though it ranks past the budget.
    expect(selectEvicted({ orderedWorktreeIds: sixWorktrees, activeWorktreeId: 'wt-6' })).toEqual([
      'wt-5'
    ])
  })

  it('counts only worktrees that actually hold live guests', () => {
    const holders = new Set(['wt-5', 'wt-6'])
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees,
        holdsLiveGuests: (worktreeId) => holders.has(worktreeId)
      })
    ).toEqual([])
  })

  it('skips worktrees that are no longer retained', () => {
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees,
        isRetained: (worktreeId) => worktreeId !== 'wt-1' && worktreeId !== 'wt-2'
      })
    ).toEqual([])
  })

  it('keeps a non-evictable worktree retained over budget instead of evicting it', () => {
    expect(
      selectEvicted({
        orderedWorktreeIds: sixWorktrees,
        isEvictable: (worktreeId) => worktreeId !== 'wt-5'
      })
    ).toEqual(['wt-6'])
  })

  it('lets a protected worktree within the budget occupy a retained slot', () => {
    expect(
      selectEvicted({
        orderedWorktreeIds: ['wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-5'],
        isEvictable: (worktreeId) => worktreeId !== 'wt-3'
      })
    ).toEqual(['wt-5'])
  })

  it('counts duplicated recency entries once', () => {
    expect(
      selectEvicted({ orderedWorktreeIds: ['wt-1', 'wt-1', 'wt-2', 'wt-3', 'wt-4', 'wt-5'] })
    ).toEqual(['wt-5'])
  })

  it('honors a custom limit', () => {
    expect(selectEvicted({ orderedWorktreeIds: sixWorktrees.slice(0, 3), limit: 1 })).toEqual([
      'wt-2',
      'wt-3'
    ])
  })
})

describe('worktreeHoldsLiveBrowserGuests', () => {
  it('detects live guests keyed by page id', () => {
    const tabs = [browserTab('workspace-1', ['page-1'])]
    const pages = { 'workspace-1': [page('page-1', 'workspace-1')] }

    expect(worktreeHoldsLiveBrowserGuests(tabs, pages, (id) => id === 'page-1')).toBe(true)
    expect(worktreeHoldsLiveBrowserGuests(tabs, pages, () => false)).toBe(false)
  })

  it('falls back to the workspace tab id for legacy sessions without pages', () => {
    const tabs = [browserTab('legacy-workspace')]

    expect(worktreeHoldsLiveBrowserGuests(tabs, {}, (id) => id === 'legacy-workspace')).toBe(true)
  })
})

describe('browserTabVisibilityPageIds', () => {
  it('mirrors the overlay slot derivation: pageIds, then activePageId, then tab id', () => {
    expect(browserTabVisibilityPageIds(browserTab('tab-1', ['page-1', 'page-2']))).toEqual([
      'page-1',
      'page-2'
    ])
    expect(browserTabVisibilityPageIds(browserTab('tab-1', [], 'page-3'))).toEqual(['page-3'])
    expect(browserTabVisibilityPageIds(browserTab('tab-1'))).toEqual(['tab-1'])
  })
})

describe('touchBrowserGuestWorktreeRecency', () => {
  it('moves a re-activated worktree to the front without duplicating it', () => {
    const recency = ['wt-2', 'wt-1']

    touchBrowserGuestWorktreeRecency(recency, 'wt-1')
    expect(recency).toEqual(['wt-1', 'wt-2'])

    touchBrowserGuestWorktreeRecency(recency, 'wt-3')
    expect(recency).toEqual(['wt-3', 'wt-1', 'wt-2'])
  })
})
