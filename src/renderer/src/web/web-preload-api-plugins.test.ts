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
    installBrowserGlobals('Linux')
    const { installWebPreloadApi } = await import('./web-preload-api')
    installWebPreloadApi()
    const { ensurePluginAutoUpdatesWatched } = await import('../store/plugin-auto-updates')
    const { requestPluginInstallCounts, usePluginInstallCountsStore } =
      await import('../store/plugin-install-counts')

    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      ensurePluginAutoUpdatesWatched()
      requestPluginInstallCounts()
      await new Promise((resolve) => setTimeout(resolve, 0))
    } finally {
      process.off('unhandledRejection', unhandled)
    }
    expect(unhandled).not.toHaveBeenCalled()
    expect(warning).not.toHaveBeenCalled()
    // The catalog indexes counts by plugin key, so they must stay a record.
    expect(usePluginInstallCountsStore.getState().counts).toEqual({})
  })
})
