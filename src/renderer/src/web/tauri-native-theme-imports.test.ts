import { afterEach, describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

function installTauriHost(invokeImpl: (command: string, args?: unknown) => unknown) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn((command: string, args?: unknown) =>
    Promise.resolve(invokeImpl(command, args))
  )
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { invoke }
}

describe('tauri theme-import previews', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('previewWarpThemeImport returns an empty found:false result when no Warp themes exist', async () => {
    installTauriHost((command) => {
      if (command === 'poc_list_directory') {
        throw new Error('Directory is outside the authorized roots.')
      }
      throw new Error(`unexpected native call: ${command}`)
    })
    const { previewTauriWarpThemeImport } = await import('./tauri-native-warp-theme-import')
    const result = await previewTauriWarpThemeImport({ kind: 'auto' })
    expect(result.found).toBe(false)
    expect(result.themes).toEqual([])
    expect(result.skippedFiles).toEqual([])
  })

  it('previewGhosttyImport returns found:false when no config is staged', async () => {
    installTauriHost((command) => {
      if (command === 'poc_stage_external_paths') {
        return { sources: [{ sourcePath: 'x', status: 'skipped', reason: 'missing' }] }
      }
      throw new Error(`unexpected native call: ${command}`)
    })
    const { previewTauriGhosttyImport } = await import('./tauri-native-ghostty-import')
    const result = await previewTauriGhosttyImport()
    expect(result.found).toBe(false)
    expect(result.diff).toEqual({})
  })
})
