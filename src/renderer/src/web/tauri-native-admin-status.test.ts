import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

function installTauriHost(result: unknown) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn(() => Promise.resolve(result))
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { invoke }
}

describe('tauri Windows administrator status', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('reports the Rust launcher probe on the Tauri host', async () => {
    const host = installTauriHost(false)
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.getWindowsAdministratorStatus?.()).resolves.toBe(false)
    expect(host.invoke).toHaveBeenCalledWith('poc_get_windows_administrator_status', undefined)
  })

  it('falls back to null off the Tauri host', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.getWindowsAdministratorStatus?.()).resolves.toBeNull()
  })
})
