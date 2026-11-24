import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { initializeTauriRuntime as InitializeTauriRuntime } from './tauri-runtime-startup'
import type { readStoredWebRuntimeEnvironment as ReadStoredWebRuntimeEnvironment } from './pairing/web-runtime-environment'
import type { getStoredSettings as GetStoredSettings } from './preload-api/preferences/web-preferences-store'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

async function loadRuntimeStartup(): Promise<{
  initializeTauriRuntime: typeof InitializeTauriRuntime
  readStoredWebRuntimeEnvironment: typeof ReadStoredWebRuntimeEnvironment
  getStoredSettings: typeof GetStoredSettings
}> {
  const [{ initializeTauriRuntime }, { readStoredWebRuntimeEnvironment }, { getStoredSettings }] =
    await Promise.all([
      import('./tauri-runtime-startup'),
      import('./pairing/web-runtime-environment'),
      import('./preload-api/preferences/web-preferences-store')
    ])
  return { initializeTauriRuntime, readStoredWebRuntimeEnvironment, getStoredSettings }
}

function pairing(endpoint: string, scope = 'runtime'): string {
  return `orca://pair?code=${Buffer.from(
    JSON.stringify({
      v: 2,
      endpoint,
      scope,
      deviceToken: 'test-token',
      publicKeyB64: 'test-key'
    })
  ).toString('base64url')}`
}

describe('Tauri owned runtime startup', () => {
  beforeEach(() => vi.resetModules())
  afterEach(() => vi.unstubAllGlobals())

  it('leaves ordinary browser startup alone', async () => {
    installBrowserGlobals('Windows')
    const { initializeTauriRuntime, readStoredWebRuntimeEnvironment } = await loadRuntimeStartup()
    await initializeTauriRuntime()
    expect(readStoredWebRuntimeEnvironment()).toBeNull()
  })

  it('replaces stale pairing before mounting without navigating to a custom scheme', async () => {
    const globals = installBrowserGlobals('Windows')
    const { initializeTauriRuntime, readStoredWebRuntimeEnvironment, getStoredSettings } =
      await loadRuntimeStartup()
    const invoke = vi.fn().mockResolvedValue(pairing('ws://127.0.0.1:6881'))
    Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
    await initializeTauriRuntime()
    invoke.mockResolvedValue(pairing('ws://127.0.0.1:6882'))
    await initializeTauriRuntime()
    expect(invoke).toHaveBeenCalledWith('poc_runtime_pairing', undefined)
    expect(JSON.stringify(readStoredWebRuntimeEnvironment())).toContain('ws://127.0.0.1:6882')
    expect(JSON.stringify(readStoredWebRuntimeEnvironment())).not.toContain('ws://127.0.0.1:6881')
    expect(getStoredSettings().activeRuntimeEnvironmentId).toBe(
      readStoredWebRuntimeEnvironment()?.id
    )
  })

  it('fails closed for a mobile offer instead of using stored runtime credentials', async () => {
    const globals = installBrowserGlobals('Windows')
    const { initializeTauriRuntime, readStoredWebRuntimeEnvironment } = await loadRuntimeStartup()
    Object.assign(globals.window, {
      __TAURI_INTERNALS__: {
        invoke: vi.fn().mockResolvedValue(pairing('ws://127.0.0.1:6881', 'mobile'))
      }
    })
    await expect(initializeTauriRuntime()).rejects.toThrow('runtime pairing offer')
    expect(readStoredWebRuntimeEnvironment()).toBeNull()
  })

  it('surfaces native startup failures', async () => {
    vi.useFakeTimers()
    try {
      const globals = installBrowserGlobals('Windows')
      const { initializeTauriRuntime } = await loadRuntimeStartup()
      Object.assign(globals.window, {
        __TAURI_INTERNALS__: {
          invoke: vi.fn((command: string) =>
            command === 'poc_browser_identity_set_renderer_user_agent'
              ? Promise.resolve(true)
              : Promise.reject(new Error('runtime unavailable'))
          )
        }
      })
      const assertion = expect(initializeTauriRuntime()).rejects.toThrow('runtime unavailable')
      await vi.runAllTimersAsync()
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
