import { describe, expect, it, vi } from 'vitest'
import { applyBrowserPageZoomLevel, DEFAULT_BROWSER_PAGE_ZOOM_LEVEL } from './browser-page-zoom'

describe('applyBrowserPageZoomLevel', () => {
  it('writes a normalized level when the guest is not already there', () => {
    const target = {
      getZoomLevel: vi.fn(() => 3),
      setZoomLevel: vi.fn()
    }

    expect(applyBrowserPageZoomLevel(target, DEFAULT_BROWSER_PAGE_ZOOM_LEVEL)).toBe(0)
    expect(target.setZoomLevel).toHaveBeenCalledWith(0)
  })

  it('does not write when the guest is already at the requested level', () => {
    const target = {
      getZoomLevel: vi.fn(() => 0),
      setZoomLevel: vi.fn()
    }

    expect(applyBrowserPageZoomLevel(target, 0)).toBe(0)
    expect(target.setZoomLevel).not.toHaveBeenCalled()
  })

  it('returns null for a destroyed guest', () => {
    const target = {
      isDestroyed: () => true,
      getZoomLevel: vi.fn(() => 3),
      setZoomLevel: vi.fn()
    }

    expect(applyBrowserPageZoomLevel(target, 0)).toBeNull()
    expect(target.setZoomLevel).not.toHaveBeenCalled()
  })
})
