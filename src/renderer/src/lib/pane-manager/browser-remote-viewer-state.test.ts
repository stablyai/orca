import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  hydrateBrowserRemoteViewerPages,
  isBrowserPageRemotelyViewed,
  onBrowserRemoteViewerChange,
  setRemoteViewersForBrowserPage
} from './browser-remote-viewer-state'

afterEach(() => {
  hydrateBrowserRemoteViewerPages([])
})

describe('browser-remote-viewer-state', () => {
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
