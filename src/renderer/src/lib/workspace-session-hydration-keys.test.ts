import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/types'
import { collectWorktreeRecoveryRepoIdsFromSession } from './workspace-session-hydration-keys'

describe('collectWorktreeRecoveryRepoIdsFromSession', () => {
  it('ignores folder workspaces and worktrees without persisted terminal sessions', () => {
    const session = {
      activeWorktreeIdsOnShutdown: [
        'repo-a::/worktree-a',
        'repo-b::/worktree-b',
        'folder:folder-1'
      ],
      tabsByWorktree: {
        'repo-a::/worktree-a': [{ ptyId: 'pty-a' }],
        'repo-b::/worktree-b': [{ ptyId: null }],
        'folder:folder-1': [{ ptyId: 'pty-folder' }]
      }
    } as unknown as WorkspaceSessionState

    expect(collectWorktreeRecoveryRepoIdsFromSession(session)).toEqual(['repo-a'])
  })

  it('recognizes split-pane and remote persisted sessions', () => {
    const session = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      terminalLayoutsByTabId: {
        'tab-a': { ptyIdsByLeafId: { 'pane:1': 'pty-a' } }
      },
      tabsByWorktree: {
        'repo-a::/worktree-a': [{ id: 'tab-a', ptyId: null }],
        'repo-b::/worktree-b': [{ id: 'tab-b', ptyId: null }]
      },
      remoteSessionIdsByTabId: { 'tab-b': 'remote-session' }
    } as unknown as WorkspaceSessionState

    expect(collectWorktreeRecoveryRepoIdsFromSession(session)).toEqual(['repo-a', 'repo-b'])
  })

  it('matches canonical session keys against raw shutdown worktree IDs', () => {
    const rawWorktreeId = 'repo-a::/worktree-a'
    const session = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      activeWorktreeIdsOnShutdown: [rawWorktreeId],
      tabsByWorktree: {
        [`worktree:${rawWorktreeId}`]: [{ ptyId: 'pty-a' }]
      }
    } as unknown as WorkspaceSessionState

    expect(collectWorktreeRecoveryRepoIdsFromSession(session)).toEqual(['repo-a'])
  })

  it('excludes runtime-owned session worktrees for raw and canonical owner keys', () => {
    const rawWorktreeId = 'repo-a::/remote/worktree'
    const canonicalWorktreeKey = `worktree:${rawWorktreeId}`
    const session = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        [canonicalWorktreeKey]: [{ ptyId: 'pty-a' }]
      }
    } as unknown as WorkspaceSessionState

    expect(
      collectWorktreeRecoveryRepoIdsFromSession(session, {
        [rawWorktreeId]: 'runtime:env-1'
      })
    ).toEqual([])
    expect(
      collectWorktreeRecoveryRepoIdsFromSession(session, {
        [canonicalWorktreeKey]: 'runtime:env-1'
      })
    ).toEqual([])
  })

  it('keeps SSH-owned session worktrees eligible for local recovery routing', () => {
    const rawWorktreeId = 'repo-a::/ssh/worktree'
    const session = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        [rawWorktreeId]: [{ ptyId: 'ssh:ssh-target@@pty-a' }]
      }
    } as unknown as WorkspaceSessionState

    expect(
      collectWorktreeRecoveryRepoIdsFromSession(session, {
        [rawWorktreeId]: 'ssh:ssh-target'
      })
    ).toEqual(['repo-a'])
  })

  it('returns repository IDs in deterministic order', () => {
    const session = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        'repo-b::/worktree-b': [{ ptyId: 'pty-b' }],
        'repo-a::/worktree-a': [{ ptyId: 'pty-a' }]
      }
    } as unknown as WorkspaceSessionState

    expect(collectWorktreeRecoveryRepoIdsFromSession(session)).toEqual(['repo-a', 'repo-b'])
  })
})
