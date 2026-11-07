import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees-slice-test-fixtures'
import { getDefaultSettings } from '../../../shared/constants'
import type { Repo } from '../../../shared/repo-types'
import type { TabGroup } from '../../../shared/tab-types'

export const SSH_WORKTREE_PATH = '/home/me/wt-ssh'
export const RUNTIME_WORKTREE_PATH = '/srv/wt-runtime'

function repo(id: string, owner: Pick<Repo, 'connectionId' | 'executionHostId'>): Repo {
  return { id, path: `/${id}`, displayName: id, badgeColor: '#000', addedAt: 0, ...owner }
}

function group(id: string, worktreeId: string): TabGroup {
  return { id, worktreeId, activeTabId: null, tabOrder: [] }
}

export function sshConnectionStatesAt(
  generation: number
): ReturnType<typeof useAppStore.getState>['sshConnectionStates'] {
  return new Map([
    [
      'ssh-1',
      {
        targetId: 'ssh-1',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        connectionGeneration: generation
      }
    ]
  ])
}

/**
 * Seeds an SSH workspace (`wt-ssh`) and a runtime-owned one (`wt-runtime`) while
 * another workspace is active and a different runtime is focused.
 */
export function seedRemoteDropWorkspaces(): void {
  useAppStore.setState({
    activeWorktreeId: 'wt-a',
    settings: { ...getDefaultSettings('/home/me'), activeRuntimeEnvironmentId: 'focused-runtime' },
    repos: [
      repo('repo-ssh', { connectionId: 'ssh-1', executionHostId: 'ssh:ssh-1' }),
      repo('repo-rt', { connectionId: null, executionHostId: 'runtime:owner-runtime' })
    ],
    worktreesByRepo: {
      'repo-ssh': [makeWorktree({ id: 'wt-ssh', repoId: 'repo-ssh', path: SSH_WORKTREE_PATH })],
      'repo-rt': [
        makeWorktree({ id: 'wt-runtime', repoId: 'repo-rt', path: RUNTIME_WORKTREE_PATH })
      ]
    },
    sshConnectionStates: sshConnectionStatesAt(3),
    groupsByWorktree: {
      'wt-ssh': [group('group-ssh', 'wt-ssh')],
      'wt-runtime': [group('group-runtime', 'wt-runtime')]
    }
  })
}
