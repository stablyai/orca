import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getWorkspaceFileBrowserOpenTarget,
  REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE,
  TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE
} from './workspace-file-browser-open-target'
import { localAndSshTwinRows } from './workspace-twin-rows.test-fixture'

const mocks = vi.hoisted(() => ({
  environmentId: null as string | null,
  connectionId: null as string | null,
  twin: false
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  runtimeEnvironmentIdOrLocalUnlessTwin: () => mocks.environmentId
}))

vi.mock('@/store', () => ({
  useAppStore: {
    getState: () =>
      mocks.twin
        ? localAndSshTwinRows('repo-1', 'wt-1')
        : {
            repos: [{ id: 'repo-1', connectionId: mocks.connectionId }],
            worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] }
          }
  }
}))

beforeEach(() => {
  mocks.environmentId = null
  mocks.connectionId = null
  mocks.twin = false
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

  it('still refuses remote files, which have no local file URL', () => {
    mocks.connectionId = 'ssh-1'

    expect(
      getWorkspaceFileBrowserOpenTarget({
        filePath: '/home/alice/report.html',
        worktreeId: 'wt-1'
      })
    ).toEqual({
      status: 'unsupported',
      reason: 'remote-worktree',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE
    })
  })

  it('refuses a file:// URL for a project two hosts publish, naming why', () => {
    mocks.twin = true
    expect(
      getWorkspaceFileBrowserOpenTarget({ filePath: '/srv/repo/report.html', worktreeId: 'wt-1' })
    ).toEqual({
      status: 'unsupported',
      reason: 'remote-worktree',
      message: TWIN_FILE_BROWSER_UNSUPPORTED_MESSAGE
    })
  })

  it('refuses paired files even when their connection ID is null', () => {
    mocks.environmentId = 'managed-host'
    expect(
      getWorkspaceFileBrowserOpenTarget({
        filePath: '/srv/repo/report.html',
        worktreeId: 'wt-1'
      })
    ).toEqual({
      status: 'unsupported',
      reason: 'remote-worktree',
      message: REMOTE_FILE_BROWSER_UNSUPPORTED_MESSAGE
    })
  })
})
