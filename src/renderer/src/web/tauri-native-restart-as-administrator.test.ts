import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

const callRuntimeResult = vi.hoisted(() => vi.fn())
vi.mock('./runtime/client/web-runtime-calls', () => ({ callRuntimeResult }))

function installTauriHost(invokeImpl: (command: string) => unknown) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn((command: string) => Promise.resolve(invokeImpl(command)))
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { invoke }
}

describe('tauri restart as administrator', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('routes the request through the native elevation command', async () => {
    const host = installTauriHost(() => undefined)
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.restartAsAdministrator?.()).resolves.toBeUndefined()
    expect(host.invoke).toHaveBeenCalledWith('poc_restart_as_administrator', undefined)
  })

  it('rejects off the Tauri host like the browser fallback', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.restartAsAdministrator?.()).rejects.toThrow(
      'Administrator restart requires the Windows desktop app.'
    )
  })
})
