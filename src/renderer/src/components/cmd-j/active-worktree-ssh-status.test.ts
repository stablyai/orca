import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { RuntimeEnvironmentStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import type { SshConnectionState } from '../../../../shared/ssh-types'
import type { RuntimeEnvironmentSshBucket } from '@/store/slices/runtime-environment-ssh'
import { createTestStore, makeWorktree, TEST_REPO } from '@/store/slices/store-test-helpers'
import { makeFolderWorkspace } from '@/store/slices/worktrees-slice-test-fixtures'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { buildCmdJQuickActionContext, getActiveWorktreeSshStatus } from './quick-action-context'
import { getCmdJQuickActions } from './quick-actions'

const connection = (status: SshConnectionState['status']): SshConnectionState => ({
  targetId: 'box',
  status,
  error: null,
  reconnectAttempt: 0
})

function sshStatus(
  repo: Partial<typeof TEST_REPO> & {
    connectionId?: string
    executionHostId?: 'local' | 'ssh:box'
  },
  worktree: { repoId?: string; hostId?: 'local' | 'ssh:box' },
  status: SshConnectionState['status'] | null = 'disconnected'
) {
  return getActiveWorktreeSshStatus(
    {
      repos: [{ ...TEST_REPO, ...repo }],
      sshConnectionStates: new Map(status ? [['box', connection(status)]] : []),
      sshStateByEnvironment: new Map(),
      worktreesByRepo: {}
    },
    makeWorktree({ id: 'wt', repoId: TEST_REPO.id, ...worktree })
  )
}

describe('active workspace SSH status', () => {
  it('has none for a local workspace', () => {
    expect(sshStatus({ executionHostId: 'local' }, { hostId: 'local' })).toBeNull()
  })

  it('reads a repo that names its SSH target with connectionId', () => {
    expect(sshStatus({ connectionId: 'box' }, {})).toBe('disconnected')
    expect(sshStatus({ connectionId: 'box' }, {}, 'connected')).toBe('connected')
  })

  it('reads a repo owned through its execution host alone', () => {
    expect(sshStatus({ executionHostId: 'ssh:box' }, {})).toBe('disconnected')
    expect(sshStatus({ executionHostId: 'ssh:box' }, {}, 'connected')).toBe('connected')
  })

  it("reads a folder workspace's own SSH host when it has no repo row", () => {
    expect(sshStatus({ id: 'other-repo' }, { hostId: 'ssh:box' })).toBe('disconnected')
    expect(sshStatus({ id: 'other-repo' }, { hostId: 'ssh:box' }, 'connected')).toBe('connected')
  })

  it('treats an SSH host with no known connection as disconnected', () => {
    expect(sshStatus({ executionHostId: 'ssh:box' }, {}, null)).toBe('disconnected')
  })

  it('uses the repo on the workspace host when repo ids repeat across hosts', () => {
    const repos: Repo[] = [
      { ...TEST_REPO, executionHostId: 'ssh:box' },
      { ...TEST_REPO, executionHostId: 'local' }
    ]
    const status = getActiveWorktreeSshStatus(
      {
        repos,
        sshConnectionStates: new Map([['box', connection('disconnected')]]),
        sshStateByEnvironment: new Map(),
        worktreesByRepo: {}
      },
      makeWorktree({ id: 'wt', repoId: TEST_REPO.id, hostId: 'local' })
    )
    expect(status).toBeNull()
  })

  describe('a worktree with no host of its own and repo ids repeated across hosts', () => {
    const repos: Repo[] = [
      { ...TEST_REPO, executionHostId: 'ssh:box' },
      { ...TEST_REPO, executionHostId: 'local' }
    ]
    const read = (selectedHostId?: ExecutionHostId) =>
      getActiveWorktreeSshStatus(
        {
          repos,
          sshConnectionStates: new Map([['box', connection('disconnected')]]),
          sshStateByEnvironment: new Map(),
          worktreesByRepo: {},
          ...(selectedHostId ? { activeWorkspaceExecutionHostId: selectedHostId } : {})
        },
        makeWorktree({ id: 'wt', repoId: TEST_REPO.id })
      )

    it('follows the host the user selected', () => {
      expect(read('local')).toBeNull()
      expect(read('ssh:box')).toBe('disconnected')
    })

    it('does not guess a row when no host is selected', () => {
      expect(read()).toBeNull()
    })
  })

  describe('a workspace owned by a paired server', () => {
    const worktree = makeWorktree({
      id: 'wt',
      repoId: TEST_REPO.id,
      hostId: 'ssh:box',
      runtimeOwnerEnvironmentId: 'hub-1'
    })
    function pairedStatus(
      local: SshConnectionState['status'] | null,
      hub: SshConnectionState['status'] | null
    ) {
      const environments = new Map<string, RuntimeEnvironmentSshBucket>()
      if (hub) {
        environments.set('hub-1', {
          connectionStates: new Map([['box', connection(hub)]]),
          targetLabels: new Map(),
          targetGenerations: new Map(),
          removedTargetLabels: new Map(),
          targetsHydrated: true
        })
      }
      const reachable = new Map<string, RuntimeEnvironmentStatus>([
        [
          'hub-1',
          {
            status: {
              runtimeId: 'hub-runtime',
              rendererGraphEpoch: 1,
              graphStatus: 'ready',
              authoritativeWindowId: 1,
              liveTabCount: 0,
              liveLeafCount: 0
            },
            checkedAt: 0
          }
        ]
      ])
      return getActiveWorktreeSshStatus(
        {
          repos: [TEST_REPO],
          sshConnectionStates: new Map(local ? [['box', connection(local)]] : []),
          sshStateByEnvironment: environments,
          runtimeStatusByEnvironmentId: reachable,
          worktreesByRepo: {}
        },
        worktree
      )
    }

    it("reads the server's SSH state, not this client's map", () => {
      expect(pairedStatus(null, 'connected')).toBe('connected')
      expect(pairedStatus('connected', 'disconnected')).toBe('disconnected')
    })

    it('stays available while the server has not reported its SSH state', () => {
      expect(pairedStatus(null, null)).toBeNull()
    })
  })

  it('hides Move to Status while the active folder workspace is on a disconnected SSH host', () => {
    const folder = makeFolderWorkspace({ id: 'folder-1', executionHostId: 'ssh:box' })
    const store = createTestStore()
    store.setState({
      activeView: 'terminal',
      activeWorktreeId: folderWorkspaceKey(folder.id),
      projectGroups: [
        {
          id: folder.projectGroupId,
          name: 'Platform',
          parentPath: '/work',
          parentGroupId: null,
          createdFrom: 'manual',
          tabOrder: 0,
          isCollapsed: false,
          color: null,
          createdAt: 1,
          updatedAt: 1,
          executionHostId: 'ssh:box'
        }
      ],
      folderWorkspaces: [folder],
      sshConnectionStates: new Map<string, SshConnectionState>(),
      activeGroupIdByWorktree: { [folderWorkspaceKey(folder.id)]: 'group-1' }
    })
    const context = buildCmdJQuickActionContext({
      state: store.getState(),
      activeGroupSnapshot: null,
      openNewBrowserTab: async () => {},
      openBrowserUrl: async () => {},
      openNewMarkdownFile: async () => {},
      openNewTerminalTab: async () => {},
      openCreateWorkspace: () => {},
      deleteActiveWorkspace: () => {},
      openAddQuickCommand: () => {},
      openWorkspaceStatusPicker: () => {}
    })
    const moveToStatus = getCmdJQuickActions().find((action) => action.id === 'move-to-status')
    expect(context.sshStatus).toBe('disconnected')
    expect(moveToStatus?.isAvailable?.(context)).toEqual({
      available: false,
      reason: 'ssh-disconnected'
    })
  })
})
