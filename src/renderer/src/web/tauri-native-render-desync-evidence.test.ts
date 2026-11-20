import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './web-preload-api-test-harness'

const callRuntimeResult = vi.hoisted(() => vi.fn())
vi.mock('./runtime/client/web-runtime-calls', () => ({ callRuntimeResult }))

function installTauriHost(invokeImpl: (command: string) => unknown) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn((command: string) => Promise.resolve(invokeImpl(command)))
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { invoke }
}

describe('tauri render desync evidence', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('routes the evidence args through the native command like Electron main', async () => {
    const result = {
      directory: 'C:/profiles/Orca/terminal-render-desync-evidence/cap-1',
      pngPath: 'C:/profiles/Orca/terminal-render-desync-evidence/cap-1/corrupt.png',
      metadataPath: 'C:/profiles/Orca/terminal-render-desync-evidence/cap-1/corrupt.json'
    }
    const host = installTauriHost(() => result)
    const args = {
      captureId: 'cap-1',
      phase: 'corrupt' as const,
      pngDataUrl: 'data:image/png;base64,aGk=',
      metadata: { probe: true }
    }
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.writeTerminalRenderDesyncEvidence?.(args)).resolves.toEqual(result)
    expect(host.invoke).toHaveBeenCalledWith('poc_write_terminal_render_desync_evidence', { args })
  })

  it('rejects off the Tauri host like the browser fallback', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(
      api.app.writeTerminalRenderDesyncEvidence?.({
        captureId: 'cap-1',
        phase: 'corrupt' as const,
        pngDataUrl: 'data:image/png;base64,aGk='
      })
    ).rejects.toThrow('Terminal render evidence is unavailable in the browser fallback.')
  })
})
