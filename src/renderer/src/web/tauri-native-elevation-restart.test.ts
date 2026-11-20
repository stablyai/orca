import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

const callRuntimeResult = vi.hoisted(() => vi.fn())
vi.mock('./runtime/client/web-runtime-calls', () => ({ callRuntimeResult }))

function installTauriHost(invokeImpl: (command: string) => unknown) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn((command: string) => Promise.resolve(invokeImpl(command)))
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { globals, invoke }
}

function installStatusStub(globals: { window: Window & typeof globalThis }, status: boolean) {
  const getWindowsAdministratorStatus = vi.fn(() => Promise.resolve(status))
  Object.assign(globals.window, { api: { app: { getWindowsAdministratorStatus } } })
  return { getWindowsAdministratorStatus }
}

describe('tauri elevation restart', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('restarts the owned daemon when the marker was taken and the token is elevated', async () => {
    const { globals, invoke } = installTauriHost((command) => {
      if (command === 'poc_take_elevation_restart_request') {
        return true
      }
      throw new Error(`unexpected native call: ${command}`)
    })
    const { getWindowsAdministratorStatus } = installStatusStub(globals, true)
    callRuntimeResult.mockResolvedValue({ killedCount: 1 })
    const { consumeElevationRestartRequest } = await import('./tauri-native-elevation-restart')
    await expect(consumeElevationRestartRequest()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('poc_take_elevation_restart_request', undefined)
    expect(getWindowsAdministratorStatus).toHaveBeenCalled()
    expect(callRuntimeResult).toHaveBeenCalledWith('terminalDaemon.restart')
  })

  it('skips the daemon when no marker was taken', async () => {
    const { globals, invoke } = installTauriHost(() => false)
    const { getWindowsAdministratorStatus } = installStatusStub(globals, true)
    const { consumeElevationRestartRequest } = await import('./tauri-native-elevation-restart')
    await expect(consumeElevationRestartRequest()).resolves.toBeUndefined()
    expect(invoke).toHaveBeenCalledWith('poc_take_elevation_restart_request', undefined)
    expect(getWindowsAdministratorStatus).not.toHaveBeenCalled()
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('skips the daemon when the token is not elevated', async () => {
    const { globals } = installTauriHost(() => true)
    installStatusStub(globals, false)
    const { consumeElevationRestartRequest } = await import('./tauri-native-elevation-restart')
    await expect(consumeElevationRestartRequest()).resolves.toBeUndefined()
    expect(callRuntimeResult).not.toHaveBeenCalledWith('terminalDaemon.restart')
  })

  it('stays quiet off the Tauri host', async () => {
    installBrowserGlobals('Windows')
    const { consumeElevationRestartRequest } = await import('./tauri-native-elevation-restart')
    await expect(consumeElevationRestartRequest()).resolves.toBeUndefined()
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })

  it('stays quiet when the take call fails', async () => {
    installBrowserGlobals('Windows')
    const invoke = vi.fn(() => Promise.reject(new Error('gone')))
    Object.assign(globalThis.window, { __TAURI_INTERNALS__: { invoke } })
    const { consumeElevationRestartRequest } = await import('./tauri-native-elevation-restart')
    await expect(consumeElevationRestartRequest()).resolves.toBeUndefined()
    expect(callRuntimeResult).not.toHaveBeenCalled()
  })
})
