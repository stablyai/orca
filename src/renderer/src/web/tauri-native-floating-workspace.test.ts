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

describe('tauri floating workspace', () => {
  beforeEach(() => {
    callRuntimeResult.mockReset()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.resetModules()
  })

  it('routes floating reads through orcad like Electron main', async () => {
    installTauriHost(() => null)
    callRuntimeResult.mockImplementation((method: string) => {
      if (method === 'host.floating.getTerminalCwd') {
        return Promise.resolve('/home/kaylee')
      }
      if (method === 'host.floating.getMarkdownDirectory') {
        return Promise.resolve('/home/kaylee/floating-workspace')
      }
      throw new Error(`unexpected runtime call: ${method}`)
    })
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.getFloatingTerminalCwd?.({ path: '~' })).resolves.toBe('/home/kaylee')
    await expect(api.app.getFloatingMarkdownDirectory?.()).resolves.toBe(
      '/home/kaylee/floating-workspace'
    )
    expect(callRuntimeResult).toHaveBeenCalledWith('host.floating.getTerminalCwd', { path: '~' })
    expect(callRuntimeResult).toHaveBeenCalledWith('host.floating.getMarkdownDirectory')
  })

  it('trusts the picked directory and returns it like the Electron picker', async () => {
    const host = installTauriHost(() => '/home/kaylee/notes')
    callRuntimeResult.mockResolvedValue(undefined)
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.pickFloatingWorkspaceDirectory?.()).resolves.toBe('/home/kaylee/notes')
    expect(host.invoke).toHaveBeenCalledWith('plugin:dialog|open', {
      options: {
        title: 'Select floating workspace directory',
        directory: true,
        multiple: false
      }
    })
    expect(callRuntimeResult).toHaveBeenCalledWith('host.floating.trustDirectory', {
      dirPath: '/home/kaylee/notes'
    })
  })

  it('resolves the picked markdown file through orcad', async () => {
    installTauriHost(() => '/home/kaylee/floating-workspace/note.md')
    const document = {
      filePath: '/home/kaylee/floating-workspace/note.md',
      relativePath: 'note.md',
      basename: 'note.md',
      name: 'note'
    }
    callRuntimeResult.mockImplementation((method: string) => {
      if (method === 'host.floating.getMarkdownDirectory') {
        return Promise.resolve('/home/kaylee/floating-workspace')
      }
      if (method === 'host.floating.resolveMarkdownDocument') {
        return Promise.resolve(document)
      }
      throw new Error(`unexpected runtime call: ${method}`)
    })
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.pickFloatingMarkdownDocument?.()).resolves.toEqual(document)
    expect(callRuntimeResult).toHaveBeenCalledWith('host.floating.resolveMarkdownDocument', {
      filePath: '/home/kaylee/floating-workspace/note.md',
      directory: '/home/kaylee/floating-workspace'
    })
  })

  it('returns null when the native picker is cancelled', async () => {
    installTauriHost(() => null)
    callRuntimeResult.mockResolvedValue('/home/kaylee/floating-workspace')
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.pickFloatingWorkspaceDirectory?.()).resolves.toBeNull()
    await expect(api.app.pickFloatingMarkdownDocument?.()).resolves.toBeNull()
    expect(callRuntimeResult).not.toHaveBeenCalledWith(
      'host.floating.trustDirectory',
      expect.anything()
    )
    expect(callRuntimeResult).not.toHaveBeenCalledWith(
      'host.floating.resolveMarkdownDocument',
      expect.anything()
    )
  })

  it('falls back to empty strings off the Tauri host', async () => {
    installBrowserGlobals('Windows')
    const { createTauriNativeAppNamespaceApi } = await import('./tauri-native-platform-app-api')
    const api = createTauriNativeAppNamespaceApi()
    await expect(api.app.getFloatingTerminalCwd?.()).resolves.toBe('')
    await expect(api.app.getFloatingMarkdownDirectory?.()).resolves.toBe('')
  })
})
