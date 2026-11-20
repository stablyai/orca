// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const native = vi.hoisted(() => ({ invoke: vi.fn(), plugin: vi.fn() }))
const platform = vi.hoisted(() => ({ current: 'win32' }))
const windowsAccess = vi.hoisted(() => ({
  access: null as null | { toWindows: (path: string) => string | null }
}))

vi.mock('./tauri-native-host', () => ({
  isTauriNativeHost: () => true,
  invokeNative: native.invoke,
  invokePlugin: native.plugin,
  listenNative: () => () => {}
}))

vi.mock('./preload-api/web-shell-api', () => ({
  createShellApi: () => ({})
}))

vi.mock('./runtime/client/web-runtime-calls', () => ({
  callRuntimeResult: vi.fn()
}))

vi.mock('./preload-api/web-storage', () => ({
  getBrowserPlatform: () => platform.current
}))

vi.mock('@/lib/files/os-open/windows-path-access', () => ({
  getWindowsPathAccess: () => windowsAccess.access
}))

import { createTauriNativeShellApi } from './tauri-native-shell-api'

function requireShell() {
  const api = createTauriNativeShellApi()
  const { openInFileManager, openPath, openFilePath, openFileUri, openUrl, pathsExist } = api ?? {}
  if (!openInFileManager || !openPath || !openFilePath || !openFileUri || !openUrl || !pathsExist) {
    throw new Error('expected tauri shell api')
  }
  return { openInFileManager, openPath, openFilePath, openFileUri, openUrl, pathsExist }
}

const existing = new Set<string>()

function unc(path: string): string {
  return `\\\\${path}`
}

describe('tauri native shell open ownership', () => {
  beforeEach(() => {
    native.invoke.mockReset()
    native.plugin.mockReset()
    native.plugin.mockResolvedValue(undefined)
    native.invoke.mockImplementation(
      async (command: string, args: { path?: unknown; paths?: unknown } = {}) => {
        if (command === 'poc_path_exists') {
          return typeof args.path === 'string' && existing.has(args.path)
        }
        if (command === 'poc_paths_exist') {
          if (!Array.isArray(args.paths)) {
            throw new Error('expected paths array')
          }
          return args.paths.map((path) => typeof path === 'string' && existing.has(path))
        }
        throw new Error(`unexpected invoke: ${command}`)
      }
    )
    windowsAccess.access = null
    platform.current = 'win32'
    existing.clear()
  })

  it('reveals an existing local path', async () => {
    existing.add('C:\\dl\\a.txt')
    const shell = requireShell()
    await expect(shell.openInFileManager('C:\\dl\\a.txt', 'local')).resolves.toEqual({
      ok: true
    })
    expect(native.plugin).toHaveBeenCalledWith('opener', 'reveal_item_in_dir', {
      path: 'C:\\dl\\a.txt'
    })
  })

  it('refuses an ssh owner without touching the os', async () => {
    existing.add('C:\\dl\\a.txt')
    const shell = requireShell()
    await expect(shell.openInFileManager('C:\\dl\\a.txt', 'ssh:target')).resolves.toEqual({
      ok: false,
      reason: 'remote-runtime-unsupported'
    })
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('refuses an absent owner without touching the os', async () => {
    existing.add('C:\\dl\\a.txt')
    const shell = requireShell()
    await expect(
      shell.openInFileManager(
        'C:\\dl\\a.txt',
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the native boundary takes unknown; the test proves an absent owner is refused.
        undefined as unknown as Parameters<typeof shell.openInFileManager>[1]
      )
    ).resolves.toEqual({ ok: false, reason: 'remote-runtime-unsupported' })
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('refuses a relative local path', async () => {
    const shell = requireShell()
    await expect(shell.openInFileManager('dl\\a.txt', 'local')).resolves.toEqual({
      ok: false,
      reason: 'not-absolute'
    })
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('reports a missing local path', async () => {
    const shell = requireShell()
    await expect(shell.openInFileManager('C:\\missing\\a.txt', 'local')).resolves.toEqual({
      ok: false,
      reason: 'not-found'
    })
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('maps a wsl runtime owner through unc', async () => {
    const target = unc('wsl.localhost\\Ubuntu\\home\\u\\a.txt')
    existing.add(target)
    windowsAccess.access = {
      toWindows: (path: string) => (path === '/home/u/a.txt' ? target : null)
    }
    const shell = requireShell()
    await expect(shell.openInFileManager('/home/u/a.txt', 'runtime:env-1')).resolves.toEqual({
      ok: true
    })
    expect(native.plugin).toHaveBeenCalledWith('opener', 'reveal_item_in_dir', {
      path: target
    })
  })

  it('refuses a wsl path with no windows spelling', async () => {
    windowsAccess.access = { toWindows: () => null }
    const shell = requireShell()
    await expect(shell.openInFileManager('relative.txt', 'runtime:env-1')).resolves.toEqual({
      ok: false,
      reason: 'not-absolute'
    })
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('openPath reveals instead of opening, and stays silent on refusal', async () => {
    existing.add('C:\\dl\\a.txt')
    const shell = requireShell()
    await shell.openPath('C:\\dl\\a.txt', 'local')
    expect(native.plugin).toHaveBeenCalledWith('opener', 'reveal_item_in_dir', {
      path: 'C:\\dl\\a.txt'
    })
    native.plugin.mockClear()
    await shell.openPath('C:\\dl\\a.txt', 'ssh:target')
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('openFilePath gates on owner and existence', async () => {
    existing.add('C:\\dl\\a.txt')
    const shell = requireShell()
    await expect(shell.openFilePath('C:\\dl\\a.txt', 'local')).resolves.toBe(true)
    expect(native.plugin).toHaveBeenCalledWith('opener', 'open_path', {
      path: 'C:\\dl\\a.txt',
      with: null
    })
    await expect(shell.openFilePath('C:\\missing\\a.txt', 'local')).resolves.toBe(false)
    await expect(shell.openFilePath('C:\\dl\\a.txt', 'ssh:target')).resolves.toBe(false)
  })

  it('openFileUri stays silent on remote hosts, missing files and bad uris', async () => {
    existing.add('C:\\dl\\a.txt')
    const shell = requireShell()
    await shell.openFileUri('file://remote-host/C:/dl/a.txt', 'local')
    await shell.openFileUri('file:///C:/missing/a.txt', 'local')
    await expect(shell.openFileUri('ftp://example.com/a.txt', 'local')).resolves.toBeUndefined()
    await expect(shell.openFileUri('::not-a-uri::', 'local')).resolves.toBeUndefined()
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('openUrl stays silent on disallowed or malformed urls', async () => {
    const shell = requireShell()
    await expect(shell.openUrl('ftp://example.com/a.txt')).resolves.toBeUndefined()
    await expect(shell.openUrl('::not-a-uri::')).resolves.toBeUndefined()
    expect(native.plugin).not.toHaveBeenCalled()
  })

  it('pathsExist enforces the shared batch cap', async () => {
    const shell = requireShell()
    await expect(shell.pathsExist(Array.from({ length: 129 }, () => 'C:\\a'))).rejects.toThrow(
      'Invalid path existence batch'
    )
    existing.add('C:\\a')
    await expect(shell.pathsExist(['C:\\a', 'C:\\b'])).resolves.toEqual([true, false])
  })
})
