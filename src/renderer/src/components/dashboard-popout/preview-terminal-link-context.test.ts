import { describe, expect, it, vi } from 'vitest'
import { previewTerminalLinkContext } from './preview-terminal-link-context'

const state = vi.hoisted(() => ({
  worktreesByRepo: {
    repo: [
      { id: 'wt', repoId: 'repo', path: '/local', hostId: 'local' },
      { id: 'wt', repoId: 'repo', path: '/remote', hostId: 'runtime:server' }
    ]
  },
  folderWorkspaces: [
    { id: 'folder', projectGroupId: 'group', folderPath: '/folder', executionHostId: 'local' }
  ],
  settings: { openLinksInApp: true }
}))
vi.mock('@/store', () => ({ useAppStore: { getState: () => state } }))
vi.mock('@/components/terminal-pane/terminal-pane-wsl-distro', () => ({
  resolvePaneWslDistro: () => null
}))
vi.mock('@/lib/workspace-browser-route-eligibility', () => ({
  canOpenWorkspaceBrowserTabOnRuntime: () => false,
  canOpenWorkspaceBrowserTabOnSsh: () => false
}))

describe('preview link source context', () => {
  it('uses the card host for colliding workspace IDs and shared browser eligibility', () => {
    const local = previewTerminalLinkContext({
      worktreeId: 'wt',
      tabId: 'tab',
      executionHostId: 'local'
    })
    const remote = previewTerminalLinkContext({
      worktreeId: 'wt',
      tabId: 'tab',
      executionHostId: 'runtime:server'
    })
    expect(local.worktreePath).toBe('/local')
    expect(local.actionDestinations).toEqual({ primary: 'orca', alternate: 'system' })
    expect(remote.worktreePath).toBe('/remote')
    expect(remote.sourceOwner).toEqual({ kind: 'runtime', runtimeEnvironmentId: 'server' })
    expect(remote.actionDestinations).toEqual({ primary: 'system' })
  })

  it('uses folder workspaces and falls back to the system browser without a workspace surface', () => {
    const folder = previewTerminalLinkContext({
      worktreeId: 'folder:folder',
      tabId: 'tab',
      executionHostId: 'local'
    })
    expect(folder.worktreePath).toBe('/folder')
    const popout = previewTerminalLinkContext({
      worktreeId: 'absent',
      tabId: 'tab',
      executionHostId: 'local'
    })
    expect(popout.worktreePath).toBe('')
    expect(popout.actionDestinations).toEqual({ primary: 'system' })
    expect(previewTerminalLinkContext().actionDestinations).toEqual({ primary: 'system' })
  })
})
