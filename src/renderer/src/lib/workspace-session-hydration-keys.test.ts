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

  it('excludes runtime-owned session worktrees', () => {
    const session = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {
        'repo-a::/remote/worktree': [{ ptyId: 'pty-a' }]
      }
    } as unknown as WorkspaceSessionState

    expect(
      collectWorktreeRecoveryRepoIdsFromSession(session, {
        'repo-a::/remote/worktree': 'runtime:env-1'
      })
    ).toEqual([])
  })
})
