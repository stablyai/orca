// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  browserPageNeedsPaintRetention,
  collectBrowserPageIds,
  onBrowserGuestPaintRetentionChange,
  useBrowserGuestPaintRetention
} from './browser-guest-paint-retention'
import {
  hydrateBrowserDrivers,
  setDriverForBrowserPage
} from '../../../lib/pane-manager/browser-mobile-driver-state'
import {
  hydrateBrowserRemoteViewerPages,
  setRemoteViewersForBrowserPage
} from '../../../lib/pane-manager/browser-remote-viewer-state'
import {
  acquireBrowserAutomationVisibility,
  releaseBrowserAutomationVisibility
} from './browser-automation-visibility'

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

describe('useBrowserGuestPaintRetention', () => {
  afterEach(() => {
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  it('retains a hidden container for a phone driving one of its pages', () => {
    hydrateBrowserDrivers([
      { browserPageId: 'page-b', driver: { kind: 'mobile', clientId: 'phone-1' } }
    ])
    expect(
      renderHook(() => useBrowserGuestPaintRetention(['page-a', 'page-b'])).result.current
    ).toBe(true)
  })

  // Why: a paired desktop/web/CLI client never takes the presence lock, so the driver term above
  // cannot cover it and its stream would go dark behind a hidden ancestor.
  it('retains a hidden container for a page a paired client is watching', () => {
    hydrateBrowserRemoteViewerPages(['page-b'])
    expect(
      renderHook(() => useBrowserGuestPaintRetention(['page-a', 'page-b'])).result.current
    ).toBe(true)
  })

  it('releases a hidden container once nothing drives or watches its pages', () => {
    hydrateBrowserRemoteViewerPages(['page-elsewhere'])
    expect(
      renderHook(() => useBrowserGuestPaintRetention(['page-a', 'page-b'])).result.current
    ).toBe(false)
  })
})

// The imperative twin, for retention decisions taken outside a render (the eviction budget).
describe('browserPageNeedsPaintRetention', () => {
  afterEach(() => {
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  it('answers for each term on its own', () => {
    expect(browserPageNeedsPaintRetention('page-a')).toBe(false)

    hydrateBrowserRemoteViewerPages(['page-a'])
    expect(browserPageNeedsPaintRetention('page-a')).toBe(true)
    hydrateBrowserRemoteViewerPages([])

    hydrateBrowserDrivers([
      { browserPageId: 'page-a', driver: { kind: 'mobile', clientId: 'phone-1' } }
    ])
    expect(browserPageNeedsPaintRetention('page-a')).toBe(true)
    hydrateBrowserDrivers([])

    const token = acquireBrowserAutomationVisibility('page-a')
    expect(browserPageNeedsPaintRetention('page-a')).toBe(true)
    releaseBrowserAutomationVisibility(token)
    expect(browserPageNeedsPaintRetention('page-a')).toBe(false)
  })

  it('stays scoped to the page asked about', () => {
    hydrateBrowserRemoteViewerPages(['page-a'])
    expect(browserPageNeedsPaintRetention('page-b')).toBe(false)
  })
})

describe('onBrowserGuestPaintRetentionChange', () => {
  afterEach(() => {
    hydrateBrowserDrivers([])
    hydrateBrowserRemoteViewerPages([])
  })

  // Why every channel: the eviction budget caches its decision until something invalidates it, so a
  // term that never notifies leaves a streamed guest queued for destruction until an unrelated bump.
  it('fires for automation, driver and remote-viewer changes alike', () => {
    const listener = vi.fn()
    const unsubscribe = onBrowserGuestPaintRetentionChange(listener)

    const token = acquireBrowserAutomationVisibility('page-a')
    expect(listener).toHaveBeenCalledTimes(1)
    releaseBrowserAutomationVisibility(token)
    expect(listener).toHaveBeenCalledTimes(2)

    setDriverForBrowserPage('page-a', { kind: 'mobile', clientId: 'phone-1' })
    expect(listener).toHaveBeenCalledTimes(3)

    setRemoteViewersForBrowserPage('page-a', true)
    expect(listener).toHaveBeenCalledTimes(4)

    unsubscribe()
    setRemoteViewersForBrowserPage('page-a', false)
    setDriverForBrowserPage('page-a', { kind: 'idle' })
    expect(listener).toHaveBeenCalledTimes(4)
  })
})
