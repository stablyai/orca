import { afterEach, describe, expect, it, vi } from 'vitest'

type ZoomMocks = {
  getZoomLevel: ReturnType<typeof vi.fn>
  setProperty: ReturnType<typeof vi.fn>
  setZoomLevel: ReturnType<typeof vi.fn>
  syncWindowChrome: ReturnType<typeof vi.fn>
}

type UIZoomModule = {
  applyUIZoom: (level: number) => void
  syncZoomCSSVar: () => void
}

async function loadUIZoom(
  userAgent: string,
  currentLevel = 0
): Promise<{
  module: UIZoomModule
  mocks: ZoomMocks
}> {
  vi.resetModules()
  const mocks: ZoomMocks = {
    getZoomLevel: vi.fn(() => currentLevel),
    setProperty: vi.fn(),
    setZoomLevel: vi.fn(),
    syncWindowChrome: vi.fn()
  }
  vi.stubGlobal('navigator', { userAgent })
  vi.stubGlobal('window', {
    api: {
      ui: {
        getZoomLevel: mocks.getZoomLevel,
        setZoomLevel: mocks.setZoomLevel,
        syncWindowChrome: mocks.syncWindowChrome
      }
    }
  })
  vi.stubGlobal('document', {
    documentElement: {
      style: {
        setProperty: mocks.setProperty
      }
    }
  })

  return { module: await import('./ui-zoom'), mocks }
}

describe('UI zoom native window chrome sync', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('updates Windows window-controls overlay geometry when UI zoom changes', async () => {
    const { module, mocks } = await loadUIZoom('Windows NT 10.0')

    module.applyUIZoom(2)

    expect(mocks.setZoomLevel).toHaveBeenCalledWith(2)
    expect(mocks.setProperty).toHaveBeenCalledWith('--ui-zoom-factor', '1.44')
    expect(mocks.syncWindowChrome).toHaveBeenCalledWith(1.44)
  })

  it('syncs restored native chrome on Windows and macOS but not Linux', async () => {
    for (const [userAgent, expectedCalls] of [
      ['Windows NT 10.0', 1],
      ['Macintosh', 1],
      ['Linux', 0]
    ] as const) {
      const { module, mocks } = await loadUIZoom(userAgent, 1)

      module.syncZoomCSSVar()

      expect(mocks.setProperty).toHaveBeenCalledWith('--ui-zoom-factor', '1.2')
      expect(mocks.syncWindowChrome).toHaveBeenCalledTimes(expectedCalls)
    }
  })
})
