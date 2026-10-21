import { describe, expect, it } from 'vitest'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import {
  makeFolderWorkspace,
  makeRepo,
  makeWorktree
} from '@/components/worktree-jump-palette-test-fixtures'
import { readWindowDesktopSidebarFacts } from './desktop-facts-shadow'

function sshState(status: SshConnectionState['status']): SshConnectionState {
  return { targetId: 'box', status, error: null, reconnectAttempt: 0 }
}

describe('readWindowDesktopSidebarFacts', () => {
  it("reads the window's own store in main's shape", () => {
    const local = makeRepo()
    const ssh = { ...makeRepo(), id: 'repo-ssh', connectionId: 'box' }
    const server = { ...makeRepo(), id: 'repo-server', executionHostId: 'runtime:env-1' as const }
    const facts = readWindowDesktopSidebarFacts({
      activeWorktreeId: 'repo-1::/a',
      activeWorkspaceExecutionHostId: 'local',
      worktreesByRepo: {
        'repo-1': [
          makeWorktree('repo-1::/b', 'b', { isPinned: true }),
          makeWorktree('repo-1::/a', 'a')
        ]
      },
      folderWorkspaces: [makeFolderWorkspace({ id: 'f1', isPinned: true })],
      repos: [server, ssh, local],
      workspaceHostOrder: ['ssh:box', 'local'],
      sshTargetLabels: new Map([['box', 'Build box']]),
      sshConnectionStates: new Map([['box', sshState('auth-failed')]]),
      wslHostStatuses: {
        'env-2': { environmentId: 'env-2', distro: 'Ubuntu', state: 'ready', detail: null }
      }
    })
    expect(facts).toEqual({
      desktopActive: { hostId: 'local', worktreeId: 'repo-1::/a' },
      pinnedWorkspaceIds: ['folder:f1', 'repo-1::/b'],
      // A paired server orders its own projects; only this host's are compared.
      repoOrder: [
        { hostId: 'ssh:box', repoId: 'repo-ssh' },
        { hostId: 'local', repoId: 'repo-1' }
      ],
      workspaceHostOrder: ['ssh:box', 'local'],
      sshHosts: { 'ssh:box': { label: 'Build box', status: 'auth-failed' } },
      wslHosts: { 'runtime:env-2': { distro: 'Ubuntu', state: 'ready' } }
    })
  })
})
