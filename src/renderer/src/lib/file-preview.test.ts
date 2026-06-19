import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  getWorkspaceFileBrowserOpenTarget,
  openFileInBrowserTab
} from './file-preview'

const mocks = vi.hoisted(() => ({
  createBrowserTab: vi.fn(),
  connectionId: null as string | null
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => ({
      createBrowserTab: mocks.createBrowserTab,
      repos: [{ id: 'repo-1', connectionId: mocks.connectionId }],
      worktreesByRepo: {
        'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }]
      }
    })
  }
}))

beforeEach(() => {
  vi.clearAllMocks()
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
