import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as UIZoomModule from './ui-zoom'

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64)'

/** Install platform/preload before fresh module evaluation; isMac is captured at import time. */
async function loadUIZoom(
  args: { level?: number; userAgent?: string; withBridge?: boolean } = {}
): Promise<{
  module: typeof UIZoomModule
  setProperty: ReturnType<typeof vi.fn>
  setZoomLevel: ReturnType<typeof vi.fn>
  syncTrafficLights: ReturnType<typeof vi.fn>
  setLevel: (level: number) => void
}> {
  const { level = 0, userAgent = LINUX_UA, withBridge = true } = args
  let current = level
  const setProperty = vi.fn()
  const setZoomLevel = vi.fn((next: number) => {
    current = next
  })
  const syncTrafficLights = vi.fn()

  vi.stubGlobal('navigator', { userAgent })
  vi.stubGlobal('document', { documentElement: { style: { setProperty } } })
  vi.stubGlobal(
    'window',
    withBridge
      ? { api: { ui: { getZoomLevel: () => current, setZoomLevel, syncTrafficLights } } }
      : {}
  )

  vi.resetModules()
  const module = await import('./ui-zoom')
  return { module, setProperty, setZoomLevel, syncTrafficLights, setLevel: (l) => (current = l) }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('windowDipToCssPx', () => {
  // Fixed native-DIP boxes must shrink in CSS pixels as UI zoom grows, so box × factor stays native size (STA-7568).
  it('converts a DIP size into the CSS px that occupies it at the live zoom level', async () => {
    const { module, setLevel } = await loadUIZoom()

    for (const level of [0, 1, -1, 0.5, 5]) {
      setLevel(level)
      const zoomFactor = 1.2 ** level
      expect(module.windowDipToCssPx(390) * zoomFactor).toBeCloseTo(390)
    }
  })

  it('is identity at 100% zoom', async () => {
    const { module } = await loadUIZoom({ level: 0 })

    expect(module.windowDipToCssPx(390)).toBe(390)
  })

  it('falls back to unscaled CSS px when no preload zoom bridge exists', async () => {
    // The web client serves the same renderer without a webFrame to zoom.
    const { module } = await loadUIZoom({ withBridge: false })

    expect(module.windowDipToCssPx(390)).toBe(390)
  })
})

describe('applyUIZoom', () => {
  it('sets the webFrame level and publishes the matching factor', async () => {
    const { module, setProperty, setZoomLevel } = await loadUIZoom()

    module.applyUIZoom(1)

    expect(setZoomLevel).toHaveBeenCalledWith(1)
    expect(setProperty).toHaveBeenCalledWith('--ui-zoom-factor', String(1.2))
  })

  it('repositions native traffic lights on macOS only', async () => {
    const mac = await loadUIZoom({ userAgent: MAC_UA })
    mac.module.applyUIZoom(1)
    expect(mac.syncTrafficLights).toHaveBeenCalledWith(1.2)

    const linux = await loadUIZoom({ userAgent: LINUX_UA })
    linux.module.applyUIZoom(1)
    expect(linux.syncTrafficLights).not.toHaveBeenCalled()
  })
})

describe('syncZoomCSSVar', () => {
  it('publishes the restored level without rewriting it', async () => {
    const { module, setProperty, setZoomLevel } = await loadUIZoom({ level: 1 })

    module.syncZoomCSSVar()

    expect(setProperty).toHaveBeenCalledWith('--ui-zoom-factor', String(1.2))
    // Main restores zoom before hydration; writing it back can clobber a newer level.
    expect(setZoomLevel).not.toHaveBeenCalled()
  })
})
