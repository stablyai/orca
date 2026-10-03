import type { ILink } from '@xterm/xterm'
import { describe, expect, it, vi } from 'vitest'
import { getConnectionId } from '@/lib/connection-context'
import { activateAndRevealWorkspace, activateAndRevealWorktree } from '@/lib/worktree-activation'
import { openDetectedFilePath } from './terminal-link-handlers'
import {
  getTerminalFileContext,
  shouldOpenTerminalFileWithSystemDefault
} from './terminal-file-open-routing'
import { downloadAndOpenRemoteTerminalFile } from './terminal-remote-file-download-open'
import { createTerminalLinkTestDoubles } from './terminal-link-handlers-test-fixtures'
import { createProviderSetup, makeBufferLine } from './terminal-link-provider-buffer-fixtures'
import {
  flushAsyncWork,
  installTerminalLinkTestEnvironment
} from './terminal-link-handlers-test-harness'
import type { RuntimeEnvironmentCallRequest } from '@/runtime/runtime-compatibility-test-fixture'

const findWorkspaceFileRouteMock = vi.hoisted(() => vi.fn())
const doubles = createTerminalLinkTestDoubles()
const {
  storeState,
  authorizeExternalPathMock,
  statMock,
  openFileMock,
  openFilePathMock,
  createBrowserTabMock,
  runtimeEnvironmentCallMock
} = doubles

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeState
  }
}))

vi.mock('@/lib/language-detect', () => ({
  detectLanguage: (filePath: string) => (filePath.endsWith('.md') ? 'markdown' : 'plaintext')
}))

vi.mock('@/lib/worktree-activation', () => ({
  activateAndRevealWorkspace: vi.fn(),
  activateAndRevealWorktree: vi.fn()
}))

vi.mock('@/lib/connection-context', () => ({
  getConnectionId: vi.fn(() => null)
}))

vi.mock('@/lib/runtime-workspace-file-route', () => ({
  findWorkspaceFileRoute: findWorkspaceFileRouteMock
}))

vi.mock('./terminal-remote-file-download-open', () => ({
  downloadAndOpenRemoteTerminalFile: vi.fn()
}))

vi.mock('@/lib/file-preview', () => ({
  getWorkspaceFilePreviewPlan: vi.fn(() => ({ status: 'unsupported' })),
  openFileInBrowserTab: vi.fn()
}))

installTerminalLinkTestEnvironment(doubles)

const runtimePane = { worktreeId: 'wt-1', worktreePath: '/srv/app', runtimeEnvironmentId: 'env-1' }
const siblingRoute = {
  worktreeId: 'wt-2',
  relativePath: 'src/index.ts',
  executionHostId: 'runtime:env-1',
  rootPath: '/srv/other'
}
const localRoute = {
  worktreeId: 'local-wt',
  relativePath: 'src/a.ts',
  executionHostId: 'local',
  rootPath: '/Users/me/repo'
}

function routeSiblingAndLocalWorkspaces(): void {
  findWorkspaceFileRouteMock.mockImplementation((_state, hostId: string, path: string) => {
    if (hostId === 'runtime:env-1' && path.startsWith('/srv/other/')) {
      return siblingRoute
    }
    if (hostId === 'local' && path.startsWith('/Users/me/repo/')) {
      return localRoute
    }
    return null
  })
}

function answerRuntimeFileCalls(): void {
  runtimeEnvironmentCallMock.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    const relativePaths = args.params?.relativePaths
    return {
      id: 'rpc-1',
      ok: true,
      result: Array.isArray(relativePaths)
        ? relativePaths.map(() => ({ exists: true }))
        : { size: 1, isDirectory: false, mtime: 1 },
      _meta: { runtimeId: 'remote-runtime' }
    }
  })
}

describe('paths a runtime pane prints outside its own workspace', () => {
  it('assigns a sibling path to its runtime workspace and any other path to this client', () => {
    routeSiblingAndLocalWorkspaces()
    const sibling = getTerminalFileContext('wt-1', '/srv/app', 'env-1', '/srv/other/src/index.ts')
    const client = getTerminalFileContext('wt-1', '/srv/app', 'env-1', '/Users/me/review.html')

    expect(sibling).toEqual(
      expect.objectContaining({
        settings: { activeRuntimeEnvironmentId: 'env-1' },
        worktreeId: 'wt-2',
        worktreePath: '/srv/other'
      })
    )
    expect(shouldOpenTerminalFileWithSystemDefault(sibling, '/srv/other/src/index.ts')).toBe(false)
    expect(client.settings).toEqual({ activeRuntimeEnvironmentId: null })
    expect(shouldOpenTerminalFileWithSystemDefault(client, '/Users/me/review.html')).toBe(true)
  })

  it('keeps an SSH-backed runtime repo on its own routing', () => {
    vi.mocked(getConnectionId).mockReturnValue('ssh-1')

    const context = getTerminalFileContext('wt-1', '/srv/app', 'env-1', '/Users/me/review.html')

    expect(context).toEqual(expect.objectContaining({ worktreeId: 'wt-1', connectionId: 'ssh-1' }))
    expect(findWorkspaceFileRouteMock).not.toHaveBeenCalled()
  })

  it('opens a client HTML file in an Orca browser tab without asking the runtime', async () => {
    const filePath = '/Users/me/Desktop/review.html'

    openDetectedFilePath(filePath, null, null, runtimePane)
    await vi.waitFor(() => expect(createBrowserTabMock).toHaveBeenCalled())

    expect(authorizeExternalPathMock).toHaveBeenCalledWith({ targetPath: filePath })
    expect(statMock).toHaveBeenCalledWith({ filePath, connectionId: undefined })
    expect(runtimeEnvironmentCallMock).not.toHaveBeenCalled()
    // Why: the tab still sits in the runtime workspace, so its host must not be dropped.
    expect(activateAndRevealWorktree).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true,
      executionHostId: 'runtime:env-1'
    })
    expect(createBrowserTabMock).toHaveBeenCalledWith(
      'wt-1',
      'file:///Users/me/Desktop/review.html',
      expect.objectContaining({
        title: 'review.html',
        activate: true,
        browserRuntimeEnvironmentId: null
      })
    )
  })

  it('opens a client file with the OS default app on Shift', async () => {
    const filePath = '/Users/me/Desktop/review.html'

    openDetectedFilePath(filePath, null, null, { ...runtimePane, openWithSystemDefault: true })
    await vi.waitFor(() => expect(openFilePathMock).toHaveBeenCalledWith(filePath))

    expect(downloadAndOpenRemoteTerminalFile).not.toHaveBeenCalled()
    expect(createBrowserTabMock).not.toHaveBeenCalled()
  })

  it('opens other client files read-only and pinned to this client', async () => {
    const filePath = '/Users/me/notes.md'

    openDetectedFilePath(filePath, null, null, runtimePane)
    await vi.waitFor(() => expect(openFileMock).toHaveBeenCalled())

    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath,
        relativePath: filePath,
        worktreeId: 'wt-1',
        runtimeEnvironmentId: null,
        readOnly: true
      }),
      { forceContentReload: true }
    )
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-1', {
      providesInitialSurface: true,
      executionHostId: 'runtime:env-1'
    })
  })

  it('opens a client file inside a local workspace editable in that workspace', async () => {
    routeSiblingAndLocalWorkspaces()
    const filePath = '/Users/me/repo/src/a.ts'

    openDetectedFilePath(filePath, null, null, runtimePane)
    await vi.waitFor(() => expect(openFileMock).toHaveBeenCalled())

    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('local-wt', {
      providesInitialSurface: true,
      executionHostId: 'local'
    })
    expect(openFileMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        filePath,
        relativePath: 'src/a.ts',
        worktreeId: 'local-wt',
        runtimeEnvironmentId: null
      })
    )
    expect(openFileMock.mock.calls[0][0]).not.toHaveProperty('readOnly')
  })

  it('reports a path missing from this client as unverifiable, not missing', async () => {
    statMock.mockRejectedValueOnce(new Error('ENOENT: no such file or directory'))
    const onOpenFailure = vi.fn()

    openDetectedFilePath('/tmp/agent-report.md', null, null, { ...runtimePane, onOpenFailure })
    await vi.waitFor(() => expect(onOpenFailure).toHaveBeenCalled())

    expect(onOpenFailure).toHaveBeenCalledWith({
      verdict: 'unverifiable',
      error: expect.objectContaining({ message: expect.stringContaining('remote host') })
    })
    expect(openFileMock).not.toHaveBeenCalled()
  })

  it('stats and opens a sibling workspace file through the runtime', async () => {
    routeSiblingAndLocalWorkspaces()
    answerRuntimeFileCalls()

    openDetectedFilePath('/srv/other/src/index.ts', null, null, runtimePane)
    await vi.waitFor(() => expect(openFileMock).toHaveBeenCalled())

    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'files.stat',
      params: { worktree: 'id:wt-2', relativePath: 'src/index.ts' },
      timeoutMs: 15_000
    })
    expect(authorizeExternalPathMock).not.toHaveBeenCalled()
    expect(statMock).not.toHaveBeenCalled()
    expect(activateAndRevealWorkspace).toHaveBeenCalledWith('wt-2', {
      providesInitialSurface: true,
      executionHostId: 'runtime:env-1'
    })
    expect(openFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/srv/other/src/index.ts',
        relativePath: 'src/index.ts',
        worktreeId: 'wt-2',
        runtimeEnvironmentId: 'env-1'
      }),
      { forceContentReload: true }
    )
  })

  it('downloads a sibling workspace file before the OS opens it on Shift', async () => {
    routeSiblingAndLocalWorkspaces()
    answerRuntimeFileCalls()

    openDetectedFilePath('/srv/other/src/index.ts', null, null, {
      ...runtimePane,
      openWithSystemDefault: true
    })
    await vi.waitFor(() => expect(downloadAndOpenRemoteTerminalFile).toHaveBeenCalled())

    expect(downloadAndOpenRemoteTerminalFile).toHaveBeenCalledWith(
      expect.objectContaining({ worktreeId: 'wt-2', worktreePath: '/srv/other' }),
      '/srv/other/src/index.ts'
    )
    expect(openFilePathMock).not.toHaveBeenCalled()
  })

  it('underlines a sibling path the runtime has and a client path this computer has', async () => {
    routeSiblingAndLocalWorkspaces()
    answerRuntimeFileCalls()
    const clientPathsExist = vi.fn(async (paths: string[]) => paths.map(() => true))
    window.api.shell.pathsExist = clientPathsExist
    const { provider } = createProviderSetup(
      [makeBufferLine('/srv/other/src/index.ts /Users/me/review.html')],
      new Map(),
      { worktreePath: '/srv/app', startupCwd: '/srv/app', runtimeEnvironmentId: 'env-1' }
    )

    const links = await new Promise<ILink[]>((resolve) =>
      provider.provideLinks(1, (provided) => resolve(provided ?? []))
    )
    await flushAsyncWork()

    expect(links.map((link) => link.text)).toEqual([
      '/srv/other/src/index.ts',
      '/Users/me/review.html'
    ])
    expect(clientPathsExist).toHaveBeenCalledWith(['/Users/me/review.html'])
    expect(runtimeEnvironmentCallMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-1',
        params: expect.objectContaining({ worktree: 'id:wt-2' })
      })
    )
  })
})
