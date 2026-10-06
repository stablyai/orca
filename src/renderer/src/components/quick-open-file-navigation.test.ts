import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => {
  const route: {
    current: {
      settings: { activeRuntimeEnvironmentId: string | null }
      connectionId: string | undefined
    }
  } = { current: { settings: { activeRuntimeEnvironmentId: null }, connectionId: undefined } }
  return {
    stat: vi.fn(),
    authorize: vi.fn(),
    open: vi.fn(() => 'owner-file-id'),
    source: vi.fn(),
    reveal: vi.fn(),
    assertCurrent: vi.fn(),
    rpc: vi.fn(),
    route
  }
})
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      settings: { followSymlinkedDirectories: false },
      openFile: mocks.open,
      setMarkdownViewMode: mocks.source
    })
  }
}))
vi.mock('@/runtime/runtime-file-client', () => ({
  statRuntimePath: mocks.stat,
  isRemoteRuntimeFileOperation: (context: { connectionId?: string }) =>
    Boolean(context.connectionId),
  isMissingRuntimePathError: (error: Error) => error.message.includes('ENOENT')
}))
vi.mock('./right-sidebar/file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({}),
  captureFileExplorerOperationGuard: () => ({
    route: mocks.route.current,
    assertCurrent: mocks.assertCurrent
  })
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  getActiveRuntimeTarget: (settings: { activeRuntimeEnvironmentId: string | null }) =>
    settings.activeRuntimeEnvironmentId
      ? { kind: 'environment', environmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' },
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/store/slices/editor/focus/editor-focus-reveal', () => ({
  scheduleEditorLineReveal: mocks.reveal
}))
import { openQuickOpenFile } from './quick-open-file-navigation'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.current = { settings: { activeRuntimeEnvironmentId: null }, connectionId: undefined }
  mocks.stat.mockResolvedValue({ isDirectory: false })
  mocks.assertCurrent.mockReset()
  vi.stubGlobal('window', { api: { fs: { authorizeExternalPath: mocks.authorize } } })
})

it('validates pasted local paths with user-named access and uses the owner-qualified reveal', async () => {
  await openQuickOpenFile('/external/guide.md', 'wt', '/repo', {
    pathQuery: '/external/guide.md',
    line: 12,
    column: 3
  })
  expect(mocks.stat).toHaveBeenCalledWith(expect.anything(), '/external/guide.md', {
    kind: 'user-file'
  })
  expect(mocks.open).toHaveBeenCalledWith(
    expect.objectContaining({
      filePath: '/external/guide.md',
      relativePath: '/external/guide.md',
      runtimeEnvironmentId: null
    })
  )
  expect(mocks.source).toHaveBeenCalledWith('owner-file-id', 'source')
  expect(mocks.reveal).toHaveBeenCalledWith(
    expect.any(Function),
    '/external/guide.md',
    12,
    3,
    'owner-file-id'
  )
})

it('keeps a literal colon filename when it exists instead of applying its apparent suffix', async () => {
  await openQuickOpenFile(
    '/repo/report',
    'wt',
    '/repo',
    { pathQuery: '/repo/report', line: 12 },
    '/repo/report:12'
  )
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/repo/report:12' }))
  expect(mocks.reveal).not.toHaveBeenCalled()
})

it('falls back from a missing literal colon filename to line navigation', async () => {
  mocks.stat.mockRejectedValueOnce(new Error('ENOENT'))
  await openQuickOpenFile(
    '/repo/file.ts',
    'wt',
    '/repo',
    { pathQuery: '/repo/file.ts', line: 12 },
    '/repo/file.ts:12'
  )
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/repo/file.ts' }))
  expect(mocks.reveal).toHaveBeenCalledWith(
    expect.any(Function),
    '/repo/file.ts',
    12,
    undefined,
    'owner-file-id'
  )
})

it('probes SSH paths only on their owning host', async () => {
  mocks.route.current.connectionId = 'ssh-a'
  await openQuickOpenFile('/external/file.ts', 'wt', '/repo', { pathQuery: '/external/file.ts' })
  expect(mocks.authorize).not.toHaveBeenCalled()
  expect(mocks.stat).toHaveBeenCalledWith(
    expect.objectContaining({ connectionId: 'ssh-a' }),
    '/external/file.ts',
    { kind: 'user-file' }
  )
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ externalSshTargetId: 'ssh-a' }))
})

it('resolves paired paths on the host and never falls back to client filesystem access', async () => {
  mocks.route.current.settings.activeRuntimeEnvironmentId = 'env-a'
  mocks.rpc.mockResolvedValue({
    exists: true,
    isDirectory: false,
    absolutePath: '/repo/file.ts',
    relativePath: 'file.ts'
  })
  await openQuickOpenFile('/repo/file.ts', 'wt', '/repo', { pathQuery: '/repo/file.ts', line: 2 })
  expect(mocks.stat).not.toHaveBeenCalled()
  expect(mocks.authorize).not.toHaveBeenCalled()
  expect(mocks.open).toHaveBeenCalledWith(
    expect.objectContaining({ runtimeEnvironmentId: 'env-a', relativePath: 'file.ts' })
  )
  mocks.rpc.mockResolvedValue({
    exists: true,
    isDirectory: false,
    absolutePath: '/outside/file.ts',
    relativePath: null
  })
  await expect(
    openQuickOpenFile('/outside/file.ts', 'wt', '/repo', { pathQuery: '/outside/file.ts' })
  ).rejects.toThrow('outside the workspace')
})

it('keeps directories, denied files, missing files and replaced owners out of the editor', async () => {
  mocks.stat.mockResolvedValueOnce({ isDirectory: true })
  await expect(openQuickOpenFile('dir', 'wt', '/repo', { pathQuery: 'dir' })).rejects.toThrow(
    'directory'
  )
  mocks.stat.mockRejectedValueOnce(new Error('EACCES'))
  await expect(
    openQuickOpenFile('file.ts', 'wt', '/repo', { pathQuery: 'file.ts' })
  ).rejects.toThrow('EACCES')
  mocks.assertCurrent.mockImplementationOnce(() => {
    throw new Error('owner changed')
  })
  await expect(
    openQuickOpenFile('file.ts', 'wt', '/repo', { pathQuery: 'file.ts' })
  ).rejects.toThrow('owner changed')
  expect(mocks.open).not.toHaveBeenCalled()
  await openQuickOpenFile('file.ts', 'wt', '/repo', { pathQuery: 'file.ts' })
  expect(mocks.open).toHaveBeenCalledOnce()
})

it.each(['C:\\repo\\file.ts', '\\\\server\\share\\file.ts'])(
  'preserves pasted Windows and UNC paths without probing on the client: %s',
  async (path) => {
    mocks.route.current.connectionId = 'ssh-windows'
    await openQuickOpenFile(path, 'wt', 'C:\\repo', { pathQuery: path, line: 3, column: 4 })
    expect(mocks.stat).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: 'ssh-windows' }),
      path,
      { kind: 'user-file' }
    )
    expect(mocks.authorize).not.toHaveBeenCalled()
    expect(mocks.reveal).toHaveBeenCalledWith(expect.any(Function), path, 3, 4, 'owner-file-id')
  }
)

it('resolves literal colon names on a paired host before treating the suffix as navigation', async () => {
  mocks.route.current.settings.activeRuntimeEnvironmentId = 'env-a'
  mocks.rpc.mockResolvedValueOnce({
    exists: true,
    isDirectory: false,
    absolutePath: '/repo/report:12',
    relativePath: 'report:12'
  })
  await openQuickOpenFile(
    '/repo/report',
    'wt',
    '/repo',
    { pathQuery: '/repo/report', line: 12 },
    '/repo/report:12'
  )
  expect(mocks.rpc).toHaveBeenCalledOnce()
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ filePath: '/repo/report:12' }))
  expect(mocks.reveal).not.toHaveBeenCalled()
  expect(mocks.stat).not.toHaveBeenCalled()
})

it('keeps a pasted POSIX file on the local workspace WSL distro before any filesystem operation', async () => {
  vi.stubGlobal('window', {
    api: {
      fs: { authorizeExternalPath: mocks.authorize },
      platform: { get: () => ({ platform: 'win32' }) }
    }
  })
  await openQuickOpenFile('/home/repo/file.ts', 'wt', '\\\\wsl.localhost\\Ubuntu\\home\\repo', {
    pathQuery: '/home/repo/file.ts',
    line: 2
  })
  expect(mocks.stat).toHaveBeenCalledWith(
    expect.anything(),
    '\\\\wsl.localhost\\Ubuntu\\home\\repo\\file.ts'
  )
  expect(mocks.open).toHaveBeenCalledWith(expect.objectContaining({ relativePath: 'file.ts' }))
  mocks.route.current.connectionId = 'ssh-a'
  await openQuickOpenFile('/home/repo/file.ts', 'wt', '\\\\wsl.localhost\\Ubuntu\\home\\repo', {
    pathQuery: '/home/repo/file.ts'
  })
  expect(mocks.stat).toHaveBeenLastCalledWith(
    expect.objectContaining({ connectionId: 'ssh-a' }),
    '/home/repo/file.ts',
    { kind: 'user-file' }
  )
})

it.each(['literal:12', 'nested/literal:12', 'literal:12:3'])(
  'selected literal suffix wins for %s',
  async (query) => {
    const selected = query.startsWith('nested/') ? query : `nested/${query}`
    await openQuickOpenFile(
      selected,
      'wt',
      '/repo',
      { pathQuery: 'literal', line: 12, column: 3 },
      query
    )
    expect(mocks.open).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: `/repo/${selected}` })
    )
    expect(mocks.reveal).not.toHaveBeenCalled()
  }
)

it.each(['contained stat', 'external stat'])(
  'cancels a selection before editor mutation after delayed %s',
  async (phase) => {
    let current = true
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    mocks.stat.mockImplementationOnce(async () => {
      await wait
      return { isDirectory: false }
    })
    const opening = openQuickOpenFile(
      phase === 'external stat' ? '/outside/file.ts' : '/repo/file.ts',
      'wt',
      '/repo',
      { pathQuery: '/repo/file.ts', line: 12 },
      undefined,
      () => {
        if (!current) {
          throw new Error('cancelled')
        }
      }
    )
    await vi.waitFor(() => expect(mocks.stat).toHaveBeenCalled())
    current = false
    release?.()
    await expect(opening).rejects.toThrow('cancelled')
    expect(mocks.open).not.toHaveBeenCalled()
    expect(mocks.reveal).not.toHaveBeenCalled()
  }
)

for (const query of ['lit:12', 'nest/lit:12', 'literal:12']) {
  it(`keeps a matching literal suffix for partial query ${query}`, async () => {
    await openQuickOpenFile(
      'nested/literal:12',
      'wt',
      '/repo',
      {
        pathQuery: query.slice(0, -3),
        line: 12
      },
      query
    )
    expect(mocks.open).toHaveBeenCalled()
    expect(mocks.reveal).not.toHaveBeenCalled()
  })
}
it('still reveals the requested line when the selected literal suffix differs', async () => {
  await openQuickOpenFile(
    'nested/literal:13',
    'wt',
    '/repo',
    { pathQuery: 'lit', line: 12 },
    'lit:12'
  )
  expect(mocks.reveal).toHaveBeenCalled()
})
