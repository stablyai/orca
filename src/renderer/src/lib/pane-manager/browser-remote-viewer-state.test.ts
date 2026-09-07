import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  getBrowserRemotelyViewedPageIds,
  hasRemoteViewerForAnyBrowserPage,
  hydrateBrowserRemoteViewerPages,
  isBrowserPageRemotelyViewed,
  onBrowserRemoteViewerChange,
  setRemoteViewersForBrowserPage
} from './browser-remote-viewer-state'

afterEach(() => {
  hydrateBrowserRemoteViewerPages([])
})

describe('browser-remote-viewer-state', () => {
  it('stores and clears the watched flag keyed by browser page id', () => {
    setRemoteViewersForBrowserPage('page-1', true)
    setRemoteViewersForBrowserPage('page-2', false)

    expect(isBrowserPageRemotelyViewed('page-1')).toBe(true)
    expect(isBrowserPageRemotelyViewed('page-2')).toBe(false)
    expect(hasRemoteViewerForAnyBrowserPage(['missing', 'page-1'])).toBe(true)
    expect(hasRemoteViewerForAnyBrowserPage(['missing', 'page-2'])).toBe(false)
    expect([...getBrowserRemotelyViewedPageIds(['missing', 'page-1', 'page-2'])]).toEqual([
      'page-1'
    ])

    setRemoteViewersForBrowserPage('page-1', false)

    expect(isBrowserPageRemotelyViewed('page-1')).toBe(false)
    expect(hasRemoteViewerForAnyBrowserPage(['page-1'])).toBe(false)
  })

  it('hydrates snapshots and notifies pages that gained or lost the signal', () => {
    setRemoteViewersForBrowserPage('page-old', true)
    const listener = vi.fn()
    const unsub = onBrowserRemoteViewerChange(listener)

    hydrateBrowserRemoteViewerPages(['page-new'])

    expect(isBrowserPageRemotelyViewed('page-old')).toBe(false)
    expect(isBrowserPageRemotelyViewed('page-new')).toBe(true)
    expect(listener).toHaveBeenCalledWith('page-old')
    expect(listener).toHaveBeenCalledWith('page-new')

    unsub()
  })
})
