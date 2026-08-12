import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  getWorkspaceFileBrowserOpenTarget,
  openFileInBrowserTab,
  openFilePreviewToSide
} from './file-preview'

const mocks = vi.hoisted(() => ({
  createBrowserTab: vi.fn(),
  createEmptySplitGroup: vi.fn(() => 'group-2'),
  createWebRuntimeSessionBrowserTab: vi.fn(),
  environmentId: null as string | null,
  connectionId: null as string | null
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
