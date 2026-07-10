import { describe, expect, it } from 'vitest'
import type { ExecutionHostId } from '../../../shared/execution-host'
import type { Repo, Worktree, WorkspaceSessionState } from '../../../shared/types'
import { reconcileWorkspaceSessionWorktreeIds } from './workspace-session-worktree-id-reconciliation'

function repo(id: string, path: string, connectionId?: string): Repo {
  return { id, path, displayName: id, badgeColor: '#000', addedAt: 0, connectionId }
}

function worktree(id: string, repoId: string, path: string, hostId?: ExecutionHostId): Worktree {
  return {
    id,
    repoId,
    path,
    hostId,
    displayName: id,
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
    lastActivityAt: 0,
    head: '',
    branch: '',
    isBare: false,
    isMainWorktree: true
  }
}

function session(oldId: string, newId?: string): WorkspaceSessionState {
  return {
    activeRepoId: oldId.split('::')[0]!,
    activeWorktreeId: oldId,
    activeWorkspaceKey: `worktree:${oldId}`,
    activeTabId: 'old-tab',
    tabsByWorktree: {
      [oldId]: [
        {
          id: 'old-tab',
          ptyId: null,
          worktreeId: oldId,
          title: 'Grok',
          customTitle: null,
          color: null,
          sortOrder: 0,
          createdAt: 1
        }
      ],
      ...(newId
        ? {
            [newId]: [
              {
                id: 'new-tab',
                ptyId: null,
                worktreeId: newId,
                title: 'Codex',
                customTitle: null,
                color: null,
                sortOrder: 1,
                createdAt: 2
              }
            ]
          }
        : {})
    },
    activeTabIdByWorktree: { [oldId]: 'old-tab' },
    activeWorktreeIdsOnShutdown: [oldId],
    terminalLayoutsByTabId: {
      'old-tab': {
        root: { type: 'leaf', leafId: 'leaf-old' },
        activeLeafId: 'leaf-old',
        expandedLeafId: null,
        ptyIdsByLeafId: { 'leaf-old': `${oldId}@@daemon-session` }
      }
    },
    sleepingAgentSessionsByPaneKey: {
      'old-tab:leaf-old': {
        paneKey: 'old-tab:leaf-old',
        tabId: 'old-tab',
        worktreeId: oldId,
        agent: 'grok',
        providerSession: null,
        prompt: '',
        state: 'working',
        capturedAt: 1,
        updatedAt: 1,
        terminalTitle: 'Grok',
        origin: 'quit'
      }
    }
  } as unknown as WorkspaceSessionState
}

describe('reconcileWorkspaceSessionWorktreeIds', () => {
  it('moves a stale local worktree id to the unique current path match', () => {
    const oldId = 'old-repo::D:/Code/orca'
    const newId = 'new-repo::D:\\Code\\orca'
    const result = reconcileWorkspaceSessionWorktreeIds({
      session: session(oldId, newId),
      repos: [repo('new-repo', 'D:\\Code\\orca')],
      worktreesByRepo: { 'new-repo': [worktree(newId, 'new-repo', 'D:\\Code\\orca')] },
      runtimeHostIdByWorkspaceSessionKey: {}
    })

    expect(result.activeWorktreeId).toBe(newId)
    expect(result.activeRepoId).toBe('new-repo')
    expect(result.tabsByWorktree[newId]?.map((tab) => tab.id)).toEqual(['old-tab', 'new-tab'])
    expect(result.tabsByWorktree[oldId]).toBeUndefined()
    expect(result.tabsByWorktree[newId]?.[0]?.worktreeId).toBe(newId)
    expect(result.sleepingAgentSessionsByPaneKey?.['old-tab:leaf-old']?.worktreeId).toBe(newId)
    expect(result.terminalLayoutsByTabId['old-tab']?.ptyIdsByLeafId?.['leaf-old']).toBe(
      `${oldId}@@daemon-session`
    )
  })

  it('does not guess when multiple worktrees share a host and normalized path', () => {
    const oldId = 'old::/repo'
    const first = 'one::/repo'
    const second = 'two::/repo'
    const original = session(oldId)
    const result = reconcileWorkspaceSessionWorktreeIds({
      session: original,
      repos: [repo('one', '/repo'), repo('two', '/repo')],
      worktreesByRepo: {
        one: [worktree(first, 'one', '/repo')],
        two: [worktree(second, 'two', '/repo')]
      },
      runtimeHostIdByWorkspaceSessionKey: {}
    })

    expect(result).toBe(original)
  })

  it('only uses the missing-repo local fallback for a unique local path match', () => {
    const oldId = 'missing::/repo'
    const localId = 'local-repo::/repo'
    const remoteId = 'remote-repo::/repo'
    const result = reconcileWorkspaceSessionWorktreeIds({
      session: session(oldId),
      repos: [repo('local-repo', '/repo'), repo('remote-repo', '/repo')],
      worktreesByRepo: {
        'local-repo': [worktree(localId, 'local-repo', '/repo')],
        'remote-repo': [worktree(remoteId, 'remote-repo', '/repo', 'ssh:builder')]
      },
      runtimeHostIdByWorkspaceSessionKey: {}
    })

    expect(result.activeWorktreeId).toBe(localId)
    expect(result.activeRepoId).toBe('local-repo')
    expect(result.tabsByWorktree[remoteId]).toBeUndefined()
  })

  it('does not cross execution hosts when paths are identical', () => {
    const oldId = 'old::/repo'
    const remoteId = 'remote::/repo'
    const original = session(oldId)
    const result = reconcileWorkspaceSessionWorktreeIds({
      session: original,
      repos: [repo('remote', '/repo')],
      worktreesByRepo: {
        remote: [worktree(remoteId, 'remote', '/repo', 'runtime:remote-host')]
      },
      runtimeHostIdByWorkspaceSessionKey: {}
    })

    expect(result).toBe(original)
  })

  it('matches an SSH repo connection id to its canonical worktree host id', () => {
    const oldId = 'old::/repo'
    const newId = 'new::/repo'
    const result = reconcileWorkspaceSessionWorktreeIds({
      session: session(oldId),
      repos: [repo('old', '/repo', 'builder'), repo('new', '/repo', 'builder')],
      worktreesByRepo: {
        new: [worktree(newId, 'new', '/repo', 'ssh:builder')]
      },
      runtimeHostIdByWorkspaceSessionKey: {}
    })

    expect(result.activeWorktreeId).toBe(newId)
    expect(result.tabsByWorktree[newId]?.[0]?.worktreeId).toBe(newId)
  })
})
