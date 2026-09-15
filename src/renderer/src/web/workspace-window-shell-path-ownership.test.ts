import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installBrowserGlobals } from './web-preload-api-test-harness'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>(),
  stat: vi.fn(async () => ({})),
  copyFile: vi.fn(),
  openPath: vi.fn(async () => ''),
  showItemInFolder: vi.fn(),
  environment: { id: 'remote', runtimeId: 'remote-runtime' },
  connectionId: null as string | null | undefined
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => ({ activeWorktreeId: 'worktree' }) } }))
vi.mock('@/lib/connection-owner-resolution', () => ({
  getConnectionIdForFileFromState: () => mocks.connectionId
}))
vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.environment.id
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => Promise<unknown>) =>
      mocks.handlers.set(name, handler)
  },
  shell: { openPath: mocks.openPath, showItemInFolder: mocks.showItemInFolder },
  dialog: {}
}))
vi.mock('node:fs/promises', () => ({
  stat: mocks.stat,
  copyFile: mocks.copyFile,
  constants: { COPYFILE_EXCL: 1 }
}))
vi.mock('../../../main/window/workspace-window-native-bridge', () => ({
  authorizeWorkspaceWindowEvent: vi.fn()
}))
vi.mock('./preload-api/web-runtime-session', () => ({
  requireActiveEnvironmentOrNull: () => ({ id: 'bootstrap', runtimeId: 'local-runtime' })
}))
const mainShellModule = '../../../main/ipc/shell'
const { registerShellHandlers } = await import(mainShellModule)
import { createShellApi } from './preload-api/web-shell-api'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.environment.runtimeId = 'remote-runtime'
  mocks.connectionId = null
  const globals = installBrowserGlobals()
  registerShellHandlers({ getSettings: () => ({}) } as never, () => 'local-runtime')
  Object.assign(globals.window, {
    orcaWorkspaceWindowNative: {
      localRuntimeId: 'local-runtime',
      runtimeEnvironments: { resolve: async () => mocks.environment },
      shell: Object.fromEntries(
        [
          'openPath',
          'openInFileManager',
          'openInExternalEditor',
          'openFilePath',
          'openFileUri',
          'pathExists',
          'copyFile'
        ].map((method) => [
          method,
          (...args: unknown[]) =>
            mocks.handlers.get(`workspaceWindow:shell:${method}`)!({}, ...args)
        ])
      )
    }
  })
})

it('declines SSH and unresolved paths even when the owning runtime is the local bootstrap', async () => {
  mocks.environment.runtimeId = 'local-runtime'
  const api = createShellApi()
  for (const connectionId of ['ssh-target', undefined]) {
    mocks.connectionId = connectionId
    expect(await api.openFilePath(resolve('same-name.pdf'))).toBe(false)
    expect(await api.pathExists(resolve('same-name.pdf'))).toBe(false)
    await expect(
      api.copyFile({ srcPath: resolve('picked.png'), destPath: resolve('remote.png') })
    ).rejects.toThrow('remote-runtime-unsupported')
  }
  expect(mocks.stat).not.toHaveBeenCalled()
})
afterEach(() => vi.unstubAllGlobals())

it('declines remote workspace paths before touching the local filesystem or shell', async () => {
  const api = createShellApi()
  const path = resolve('remote-document.pdf')
  expect(await api.openFilePath(path)).toBe(false)
  expect(await api.pathExists(path)).toBe(false)
  await api.openFileUri(pathToFileURL(path).href)
  await expect(api.copyFile({ srcPath: path, destPath: resolve('copy.pdf') })).rejects.toThrow(
    'remote-runtime-unsupported'
  )
  expect(mocks.stat).not.toHaveBeenCalled()
  expect(mocks.openPath).not.toHaveBeenCalled()
  expect(mocks.copyFile).not.toHaveBeenCalled()
})

it('opens explicit local downloads even while viewing a remote host', async () => {
  const path = resolve('download.pdf')
  expect(await createShellApi().openFilePath(path, { kind: 'local-artifact' })).toBe(true)
  expect(mocks.openPath).toHaveBeenCalledWith(path)
})

it.each(['remote-runtime', 'ssh'])(
  'declines file-manager and editor paths owned by %s',
  async (host) => {
    if (host === 'ssh') {
      mocks.environment.runtimeId = 'local-runtime'
      mocks.connectionId = 'ssh-target'
    }
    const api = createShellApi()
    const path = resolve('same-name', 'SKILL.md')
    await api.openPath(path)
    expect(await api.openInFileManager(path)).toEqual({
      ok: false,
      reason: 'remote-runtime-unsupported'
    })
    expect(await api.openInExternalEditor({ path })).toEqual({
      ok: false,
      reason: 'remote-runtime-unsupported'
    })
    expect(mocks.stat).not.toHaveBeenCalled()
    expect(mocks.showItemInFolder).not.toHaveBeenCalled()
  }
)

it('reveals an explicitly local download while viewing a remote workspace', async () => {
  const path = resolve('download.pdf')
  expect(await createShellApi().openInFileManager(path, { kind: 'local-artifact' })).toEqual({
    ok: true
  })
  expect(mocks.showItemInFolder).toHaveBeenCalledWith(path)
})

it('retains local workspace operations and fails closed on an omitted native scope', async () => {
  mocks.environment.runtimeId = 'local-runtime'
  const api = createShellApi()
  const path = resolve('local.pdf')
  expect(await api.pathExists(path)).toBe(true)
  expect(await api.openFilePath(path)).toBe(true)
  await api.copyFile({ srcPath: path, destPath: resolve('copy.pdf') })
  expect(mocks.copyFile).toHaveBeenCalledOnce()
  mocks.stat.mockClear()
  expect(await mocks.handlers.get('workspaceWindow:shell:pathExists')!({}, path)).toBe(false)
  expect(mocks.stat).not.toHaveBeenCalled()
})
