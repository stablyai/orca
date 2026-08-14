import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  canShowWorkspaceFileBrowserAction,
  getWorkspaceFileBrowserOpenTarget,
  openFileInBrowserTab,
  openFilePreviewToSide
} from './file-preview'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'

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
  layoutByWorktree: {} as Record<string, unknown>,
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
      layoutByWorktree: mocks.layoutByWorktree,
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
  mocks.layoutByWorktree = {}
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
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
    expect(mocks.createBrowserTab).not.toHaveBeenCalled()
  })

  it('does not delete a split owned by an overlapping paired preview', async () => {
    mocks.environmentId = 'runtime-1'
    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }
    mocks.createEmptySplitGroup.mockImplementationOnce(() => {
      mocks.layoutByWorktree = {
        'wt-1': {
          type: 'split',
          direction: 'horizontal',
          first: { type: 'leaf', groupId: 'group-1' },
          second: { type: 'leaf', groupId: 'group-2' }
        }
      }
      return 'group-2'
    })
    let rejectFirst!: (error: Error) => void
    let resolveSecond!: (created: boolean) => void
    mocks.createWebRuntimeSessionBrowserTab
      .mockReturnValueOnce(
        new Promise<boolean>((_resolve, reject) => {
          rejectFirst = reject
        })
      )
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          resolveSecond = resolve
        })
      )

    const preview = {
      language: 'html',
      filePath: '/srv/repo/example.html',
      worktreeId: 'wt-1',
      sourceGroupId: 'group-1'
    }
    openFilePreviewToSide(preview)
    openFilePreviewToSide(preview)
    expect(mocks.createWebRuntimeSessionBrowserTab).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        clientTargetGroupId: 'group-2',
        clientTargetGroupCreated: true
      })
    )
    rejectFirst(new Error('first preview failed'))

    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
    expect(mocks.closeEmptyGroup).not.toHaveBeenCalled()
    expect(mocks.createWebRuntimeSessionBrowserTab).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        clientTargetGroupId: 'group-2',
        clientTargetGroupCreated: false
      })
    )

    resolveSecond(true)
    await vi.waitFor(() => expect(mocks.toastError).toHaveBeenCalledOnce())
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
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(false)

    mocks.browserAvailability = { state: 'enabled', provider: 'paired-runtime' }
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState('ssh-1'), 'wt-1', '/repo/report.html')
    ).toBe(false)
  })

  it('permits local files but hides SSH paths from the local browser provider', () => {
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState(), 'wt-1', '/repo/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(browserActionState('ssh-1'), 'wt-1', '/repo/report.html')
    ).toBe(false)
  })

  it('resolves local and SSH files independently in a mixed folder workspace', () => {
    const workspaceId = folderWorkspaceKey('folder-1')
    const state = {
      folderWorkspaces: [
        {
          id: 'folder-1',
          projectGroupId: 'group-1',
          folderPath: '/workspace'
        }
      ],
      projectGroups: [{ id: 'group-1', parentGroupId: null }],
      repos: [
        {
          id: 'repo-local',
          path: '/workspace/local',
          projectGroupId: 'group-1'
        },
        {
          id: 'repo-ssh',
          path: '/workspace/remote',
          projectGroupId: 'group-1',
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: {}
    } as never

    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/local/report.html')
    ).toBe(true)
    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/remote/report.html')
    ).toBe(false)
    expect(
      canShowWorkspaceFileBrowserAction(state, workspaceId, '/workspace/unknown/report.html')
    ).toBe(false)
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
