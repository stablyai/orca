import { describe, expect, it } from 'vitest'
import { getDefaultWorkspaceSession } from '../../../../shared/constants'
import { worktreeWorkspaceKey } from '../../../../shared/workspace-scope'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import type { WorkspaceSessionState } from '../../../../shared/workspace-session-state-types'
import { buildWorkspaceTerminalReconnectPlan } from './workspace-terminal-reconnect-plan'

function makeRepo(connectionId: string | null): Repo {
  return {
    id: 'repo-ssh',
    path: '/repo-ssh',
    displayName: 'SSH',
    badgeColor: '#fff',
    addedAt: 1,
    connectionId
  }
}

function makeWorktree(id: string): Worktree {
  return {
    id,
    repoId: 'repo-ssh',
    path: '/remote/worktree',
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: false,
    displayName: 'worktree',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    linkedGitLabMR: null,
    linkedGitLabIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

function makeSession(workspaceKey: string, ptyId: string): WorkspaceSessionState {
  return {
    ...getDefaultWorkspaceSession(),
    tabsByWorktree: {
      [workspaceKey]: [
        {
          id: 'tab-ssh',
          title: 'remote',
          ptyId,
          worktreeId: workspaceKey
        } as never
      ]
    },
    terminalLayoutsByTabId: { 'tab-ssh': { root: null, activeLeafId: null, expandedLeafId: null } },
    activeWorktreeIdsOnShutdown: [workspaceKey]
  }
}

describe('buildWorkspaceTerminalReconnectPlan', () => {
  it('resolves canonical worktree keys before classifying SSH sessions', () => {
    const rawWorktreeId = 'repo-ssh::/remote/worktree'
    const workspaceKey = worktreeWorkspaceKey(rawWorktreeId)

    const plan = buildWorkspaceTerminalReconnectPlan({
      reconnectPtyIdByRetainedTabId: new Map(),
      releasedPtyIdsByTabId: new Map(),
      repos: [makeRepo('ssh-1')],
      session: makeSession(workspaceKey, 'ssh:ssh-1@@pty-1'),
      validTabIds: new Set(['tab-ssh']),
      validWorktreeIds: new Set([rawWorktreeId]),
      worktreesByRepo: { 'repo-ssh': [makeWorktree(rawWorktreeId)] }
    })

    expect(plan.pendingReconnectWorktreeIds).toEqual([workspaceKey])
    expect(plan.pendingReconnectTabByWorktree).toEqual({ [workspaceKey]: ['tab-ssh'] })
    // SSH PTYs are restored through the relay map, not the local-daemon branch.
    expect(plan.pendingReconnectPtyIdByTabId).toEqual({})
  })

  it('uses the repo id when a canonical SSH worktree has no catalog row yet', () => {
    const rawWorktreeId = 'repo-ssh::/remote/not-listed-yet'
    const workspaceKey = worktreeWorkspaceKey(rawWorktreeId)

    const plan = buildWorkspaceTerminalReconnectPlan({
      reconnectPtyIdByRetainedTabId: new Map(),
      releasedPtyIdsByTabId: new Map(),
      repos: [makeRepo('ssh-1')],
      session: makeSession(workspaceKey, 'ssh:ssh-1@@pty-1'),
      validTabIds: new Set(['tab-ssh']),
      validWorktreeIds: new Set([rawWorktreeId]),
      worktreesByRepo: {}
    })

    expect(plan.pendingReconnectPtyIdByTabId).toEqual({})
  })

  it.each(['worktree:repo-ssh', 'worktree:repo-ssh::'])(
    'rejects malformed canonical key %s even when its raw alias is valid',
    (malformedKey) => {
      const plan = buildWorkspaceTerminalReconnectPlan({
        reconnectPtyIdByRetainedTabId: new Map(),
        releasedPtyIdsByTabId: new Map(),
        repos: [makeRepo(null)],
        session: makeSession(malformedKey, 'local-pty'),
        validTabIds: new Set(['tab-ssh']),
        validWorktreeIds: new Set([malformedKey, 'repo-ssh']),
        worktreesByRepo: {}
      })

      expect(plan.pendingReconnectWorktreeIds).toEqual([])
      expect(plan.pendingReconnectTabByWorktree).toEqual({})
      expect(plan.pendingReconnectPtyIdByTabId).toEqual({})
    }
  )

  it('does not guess a local owner when a catalog-missing id has local and SSH repo owners', () => {
    const rawWorktreeId = 'repo-collision::/remote/not-listed-yet'
    const workspaceKey = worktreeWorkspaceKey(rawWorktreeId)

    const plan = buildWorkspaceTerminalReconnectPlan({
      reconnectPtyIdByRetainedTabId: new Map(),
      releasedPtyIdsByTabId: new Map(),
      repos: [
        { ...makeRepo(null), id: 'repo-collision', connectionId: null },
        { ...makeRepo('ssh-1'), id: 'repo-collision' }
      ],
      session: makeSession(workspaceKey, 'ssh:ssh-1@@pty-ambiguous'),
      validTabIds: new Set(['tab-ssh']),
      validWorktreeIds: new Set([rawWorktreeId]),
      worktreesByRepo: {}
    })

    // A first-wins repo index would advertise this remote PTY as a local daemon session.
    expect(plan.pendingReconnectPtyIdByTabId).toEqual({})
  })

  it('does not use a first catalog row when loaded worktree ids collide across hosts', () => {
    const rawWorktreeId = 'repo-collision::/same-path'
    const workspaceKey = worktreeWorkspaceKey(rawWorktreeId)

    const plan = buildWorkspaceTerminalReconnectPlan({
      reconnectPtyIdByRetainedTabId: new Map(),
      releasedPtyIdsByTabId: new Map(),
      repos: [
        { ...makeRepo(null), id: 'repo-collision' },
        { ...makeRepo('ssh-1'), id: 'repo-collision' }
      ],
      session: makeSession(workspaceKey, 'old-pty'),
      validTabIds: new Set(['tab-ssh']),
      validWorktreeIds: new Set([rawWorktreeId]),
      worktreesByRepo: {
        'repo-collision': [
          makeWorktree(rawWorktreeId),
          { ...makeWorktree(rawWorktreeId), hostId: 'ssh:ssh-1' }
        ]
      }
    })

    expect(plan.pendingReconnectPtyIdByTabId).toEqual({})
  })

  it('keeps folder keys exact and treats them as local workspace rows', () => {
    const folderKey = 'folder:folder-1'
    const plan = buildWorkspaceTerminalReconnectPlan({
      reconnectPtyIdByRetainedTabId: new Map(),
      releasedPtyIdsByTabId: new Map(),
      repos: [],
      session: makeSession(folderKey, 'local-pty-1'),
      validTabIds: new Set(['tab-ssh']),
      validWorktreeIds: new Set([folderKey]),
      worktreesByRepo: {}
    })

    expect(plan.pendingReconnectWorktreeIds).toEqual([folderKey])
    expect(plan.pendingReconnectTabByWorktree).toEqual({ [folderKey]: ['tab-ssh'] })
    expect(plan.pendingReconnectPtyIdByTabId).toEqual({ 'tab-ssh': 'local-pty-1' })
  })
})
