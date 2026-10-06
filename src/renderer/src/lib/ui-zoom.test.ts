import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as UIZoomModule from './ui-zoom'

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
const LINUX_UA = 'Mozilla/5.0 (X11; Linux x86_64)'

/** Loads a fresh copy of the module: `isMac` is resolved once at module scope,
 *  so platform and the preload bridge have to be in place before evaluation. */
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
  // STA-7568: a box pinned to a native size must shrink as UI zoom inflates the CSS px
  // it is measured in, so that box x factor lands back on the DIP size it was given.
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
    // Main restores the zoom before startup hydration runs; writing it back would be a no-op
    // at best and could clobber a level applied in between.
    expect(setZoomLevel).not.toHaveBeenCalled()
  })
})
