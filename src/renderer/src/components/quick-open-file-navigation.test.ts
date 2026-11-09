import { beforeEach, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => {
  const route: {
    current: {
      target: { kind: 'local' } | { kind: 'environment'; environmentId: string }
      connectionId: string | undefined
    }
  } = { current: { target: { kind: 'local' }, connectionId: undefined } }
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
vi.mock('@/runtime/files/metadata/runtime-file-metadata-client', () => ({
  statRuntimePath: mocks.stat,
  isMissingRuntimePathError: (error: Error) => error.message.includes('ENOENT')
}))
vi.mock('@/runtime/files/runtime-file-routing', () => ({
  isRemoteRuntimeFileOperation: (context: { connectionId?: string }) =>
    Boolean(context.connectionId)
}))
vi.mock('./right-sidebar/file-explorer/navigation/file-explorer-operation-owner', () => ({
  getFileExplorerOperationOwner: () => ({}),
  captureFileExplorerOperationGuard: () => ({
    route: mocks.route.current,
    assertCurrent: mocks.assertCurrent
  })
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: mocks.rpc
}))
vi.mock('@/runtime/rpc/compatibility/runtime-capability-proof', () => ({
  runtimeEnvironmentSupportsCapability: vi.fn(async () => true)
}))
vi.mock('@/store/slices/editor/focus/editor-focus-reveal', () => ({
  scheduleEditorLineReveal: mocks.reveal
}))
import { openQuickOpenFile } from './quick-open-file-navigation'

beforeEach(() => {
  vi.clearAllMocks()
  mocks.route.current = { target: { kind: 'local' }, connectionId: undefined }
  mocks.stat.mockResolvedValue({ isDirectory: false })
  mocks.assertCurrent.mockReset()
  vi.stubGlobal('window', { api: { fs: { authorizeExternalPath: mocks.authorize } } })
})

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
