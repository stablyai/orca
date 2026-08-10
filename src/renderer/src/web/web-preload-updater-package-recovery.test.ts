import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PreloadApi } from '../../../preload/api-types'

// Why: window.api is a fallback Proxy that answers `then`, so returning it from an async helper
// would make `await` treat it as a thenable and never settle.
function installedApi(): PreloadApi {
  return (globalThis as unknown as { window: { api: PreloadApi } }).window.api
}

describe('web preload linux package recovery methods', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', {
      localStorage: { getItem: () => null, setItem: () => {} },
      location: { protocol: 'http:' },
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    })
    vi.stubGlobal('navigator', { userAgent: 'Linux', hardwareConcurrency: 8 })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports both package recovery actions as desktop-only', async () => {
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const api = installedApi()

    // The recovery status can only originate in native main, so a web caller must fail loudly.
    await expect(api.updater.getLinuxPackageInstallInstructions()).rejects.toThrow(
      'only available in the desktop app'
    )
    await expect(api.updater.showLinuxPackage()).rejects.toThrow(
      'only available in the desktop app'
    )
  })
})
