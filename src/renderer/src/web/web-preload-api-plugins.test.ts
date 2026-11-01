import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

describe('web plugins preload API', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('sonner')
    vi.resetModules()
  })

  it('lets the startup plugin update watcher run without a desktop plugin host', async () => {
    const warning = vi.fn()
    vi.doMock('sonner', () => ({ toast: { success: vi.fn(), warning } }))
    const globals = installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const { ensurePluginAutoUpdatesWatched } = await import('../store/plugin-auto-updates')
      ensurePluginAutoUpdatesWatched()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    // The catalog indexes counts by plugin key, so they must be a record.
    await expect(globals.window.api.plugins.getInstallCounts()).resolves.toEqual({})
  })
})
