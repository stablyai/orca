import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

function installTauriHost(result: unknown) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn(() => Promise.resolve(result))
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { invoke }
}

describe('tauri feature-wall asset base URL', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reports the Rust asset URL on the Tauri host', async () => {
    const base = 'http://127.0.0.1:5174/@fs/C:/repo/resources/onboarding/feature-wall/'
    const host = installTauriHost(base)
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.getFeatureWallAssetBaseUrl?.()).resolves.toBe(base)
    expect(host.invoke).toHaveBeenCalledWith('poc_get_feature_wall_asset_base_url', undefined)
  })

  it('falls back to the web root off the Tauri host', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.getFeatureWallAssetBaseUrl?.()).resolves.toBe('/')
  })
})
