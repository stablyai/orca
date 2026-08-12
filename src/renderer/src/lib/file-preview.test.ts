import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  canShowWorkspaceFileBrowserAction,
  getWorkspaceFileBrowserOpenTarget,
  openFileInBrowserTab,
  openFilePreviewToSide
} from './file-preview'

function browserActionState(connectionId: string | null = null): never {
  return {
    repos: [{ id: 'repo-1', connectionId }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
  } as never
}

const mocks = vi.hoisted(() => ({
  browserAvailability: {
    state: 'enabled' as const,
    provider: 'local-client' as 'local-client' | 'paired-runtime'
  } as
    | { state: 'enabled'; provider: 'local-client' | 'paired-runtime' }
    | { state: 'hidden'; reason: string },
  closeEmptyGroup: vi.fn(),
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(() => 'group-2'),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  environmentId: null as string | null,
  connectionId: null as string | null,
  toastError: vi.fn()
}))

vi.mock('sonner', () => ({ toast: { error: mocks.toastError } }))

vi.mock('@/lib/client-creation-action-policy', () => ({
  getClientCreationActionPolicy: () => ({ 'managed-browser': mocks.browserAvailability })
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => mocks.environmentId
}))

vi.mock('@/runtime/web-runtime-session', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      closeEmptyGroup: mocks.closeEmptyGroup,
      createBrowserTab: mocks.createBrowserTab,
      createEmptySplitGroup: mocks.createEmptySplitGroup,
      groupsByWorktree: {},
      layoutByWorktree: {},
      repos: [{ id: 'repo-1', connectionId: mocks.connectionId }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      }
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.createWebRuntimeSessionBrowserTab.mockResolvedValue(true)
  mocks.browserAvailability = { state: 'enabled', provider: 'local-client' }
  mocks.environmentId = null
  mocks.connectionId = null
})

describe('openFileInBrowserTab', () => {
  it('opens a local file URL in the Orca browser with the filename as title', () => {
    openFileInBrowserTab({
      filePath: '/tmp/example file.html',
      worktreeId: 'wt-1'
    })

    expect(mocks.createBrowserTab).toHaveBeenCalledWith('wt-1', 'file:///tmp/example%20file.html', {
      title: 'example file.html',
      activate: true
    })
  })

  it('creates paired-runtime file browsers at the owning host', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    openFileInBrowserTab({ filePath: '/srv/repo/example.html', worktreeId: 'wt-1' })

    expect(mocks.createWebRuntimeSessionBrowserTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'runtime-1',
      url: 'file:///srv/repo/example.html',
      stagedTitle: 'example.html',
      stagedFocusAddressBar: false
    })
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('creates paired-runtime side previews in the requested split', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.createWebRuntimeSessionBrowserTab).toHaveBeenCalledWith({
      worktreeId: 'wt-1',
      environmentId: 'runtime-1',
      url: 'file:///srv/repo/example.html',
      clientTargetGroupId: 'group-2',
      clientTargetGroupCreated: true,
      focusOnCreate: false,
      stagedTitle: 'example.html',
      stagedFocusAddressBar: false
    })
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('reports a paired-runtime recovery failure without an unhandled rejection', async () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }
    mocks.createWebRuntimeSessionBrowserTab.mockRejectedValue(new Error('cleanup unknown'))

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    await vi.waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith('Unable to open this file in Orca Browser.')
    )
    expect(mocks.closeEmptyGroup).toHaveBeenCalledWith('wt-1', 'group-2')
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('does not send a runtime-owned file path to the Electron browser provider', () => {
    mocks.environmentId = 'runtime-1'

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).toHaveBeenCalledWith('Unable to open this file in Orca Browser.')
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
    expect(mocks.createWebRuntimeSessionBrowserTab).not.toHaveBeenCalled()
  })

  it('rejects unavailable paired-web previews before creating a split', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'hidden', reason: 'streaming unavailable' }

    openFilePreviewToSide({
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).toHaveBeenCalledWith('streaming unavailable')
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
    expect(mocks.createWebRuntimeSessionBrowserTab).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('does not create a side split for unsupported SSH previews', () => {
    mocks.connectionId = 'ssh-1'

    openFilePreviewToSide({
      language: 'html',
      filePath: '/home/alice/report.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    })

    expect(mocks.toastError).toHaveBeenCalledWith(REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE)
    expect(mocks.createEmptySplitGroup).not.toHaveBeenCalled()
  })

  it('returns unsupported for SSH worktrees without creating a local file URL tab', () => {
    mocks.connectionId = 'ssh-1'

    const result = openFileInBrowserTab({
      filePath: '/home/alice/report.html',
      worktreeId: 'wt-1'
    })

    expect(result).toEqual({
      status: 'unsupported',
      reason: 'remote-worktree',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE
    })
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })
})

describe('canShowWorkspaceFileBrowserAction', () => {
  it('hides incapable paired providers and permits capable runtime providers', () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'hidden', reason: 'streaming unavailable' }
    expect(canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1')).toBe(false)

    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }
    expect(canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1')).toBe(true)
  })

  it('permits local files but hides SSH paths from the local browser provider', () => {
    expect(canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1')).toBe(true)
    expect(canShowWorkspaceFileBrowserAction(browserActionState('ssh-1'), 'wt-1')).toBe(false)
  })
})

describe('getWorkspaceFileBrowserOpenTarget', () => {
  it('returns a reusable browser navigation target for local files', () => {
    expect(
      getWorkspaceFileBrowserOpenTarget({
        filePath: 'C:\\repo\\demo page.html',
        worktreeId: 'wt-1'
      })
    ).toEqual({
      status: 'ready',
      url: 'file:///C:/repo/demo%20page.html',
      title: 'demo page.html'
    })
  })
})
