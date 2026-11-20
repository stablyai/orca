import { describe, expect, it, vi } from 'vitest'
import { installBrowserGlobals } from './testing/web-preload-api-test-harness'

function installTauriHost(invokeImpl: (command: string) => unknown) {
  const globals = installBrowserGlobals('Windows')
  const invoke = vi.fn((command: string) => Promise.resolve(invokeImpl(command)))
  Object.assign(globals.window, { __TAURI_INTERNALS__: { invoke } })
  return { invoke }
}

describe('tauri settings fonts', () => {
  it('routes listFonts through the native command like Electron main', async () => {
    const fonts = ['Arial', 'Cascadia Mono', 'Consolas']
    const host = installTauriHost(() => fonts)
    const { createTauriNativeSettingsApi } = await import('./tauri-native-settings-api')
    const api = createTauriNativeSettingsApi()
    await expect(api?.listFonts?.()).resolves.toEqual(fonts)
    expect(host.invoke).toHaveBeenCalledWith('poc_list_system_fonts', undefined)
  })

  it('leaves the web empty-list fallback in place off the Tauri host', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeSettingsApi } = await import('./tauri-native-settings-api')
    expect(createTauriNativeSettingsApi()).toBeUndefined()
    const { createWebSettingsApi } = await import('./preload-api/preferences/web-settings-api')
    await expect(createWebSettingsApi().settings?.listFonts?.()).resolves.toEqual([])
  })
})
