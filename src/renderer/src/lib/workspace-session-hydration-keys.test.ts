import { describe, expect, it } from 'vitest'
import type { WorkspaceSessionState } from '../../../shared/types'
import { collectWorktreeHydrationRepoIdsFromSession } from './workspace-session-hydration-keys'

describe('collectWorktreeHydrationRepoIdsFromSession', () => {
  it('includes persisted terminal tabs and ignores folder workspaces', () => {
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

    expect(collectWorktreeHydrationRepoIdsFromSession(session)).toEqual(['repo-a', 'repo-b'])
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

    expect(collectWorktreeHydrationRepoIdsFromSession(session)).toEqual(['repo-a', 'repo-b'])
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

    expect(collectWorktreeHydrationRepoIdsFromSession(session)).toEqual(['repo-a'])
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
      collectWorktreeHydrationRepoIdsFromSession(session, {
        [rawWorktreeId]: 'runtime:env-1'
      })
    ).toEqual([])
    expect(
      collectWorktreeHydrationRepoIdsFromSession(session, {
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
      collectWorktreeHydrationRepoIdsFromSession(session, {
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

    expect(collectWorktreeHydrationRepoIdsFromSession(session)).toEqual(['repo-a', 'repo-b'])
  })

  it('excludes repositories referenced only by unbounded history maps (visit recency, default tabs)', () => {
    const session = {
      activeRepoId: null,
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: { 'repo-chrome::/wt': [{ ptyId: 'pty-a' }] },
      lastVisitedAtByWorktreeId: {
        'repo-chrome::/wt': 10,
        'repo-history-only::/visited': 20
      },
      defaultTerminalTabsAppliedByWorktreeId: {
        'repo-default-only::/applied': true
      }
    } as unknown as WorkspaceSessionState

    // Why: history-only repos hydrate their maps unfiltered and would bloat the selective fetch.
    expect(collectWorktreeHydrationRepoIdsFromSession(session)).toEqual(['repo-chrome'])
  })

  it('includes a repository referenced only by activeRepoId (no active worktree, no tabs)', () => {
    const session = {
      activeRepoId: 'repo-active-only',
      activeWorktreeId: null,
      activeTabId: null,
      tabsByWorktree: {}
    } as unknown as WorkspaceSessionState

    expect(collectWorktreeHydrationRepoIdsFromSession(session)).toEqual(['repo-active-only'])
  })

  it('includes repositories referenced only by active, editor, browser, or sleeping-agent state', () => {
    const session = {
      activeRepoId: null,
      activeWorktreeId: 'repo-active::/active',
      activeTabId: null,
      tabsByWorktree: {},
      terminalLayoutsByTabId: {},
      openFilesByWorktree: { 'repo-editor::/editor': [] },
      browserTabsByWorktree: { 'repo-browser::/browser': [] },
      sleepingAgentSessionsByPaneKey: {
        'tab:leaf': { worktreeId: 'repo-agent::/agent' }
      }
    } as unknown as WorkspaceSessionState

    expect(collectWorktreeHydrationRepoIdsFromSession(session)).toEqual([
      'repo-active',
      'repo-agent',
      'repo-browser',
      'repo-editor'
    ])
  })
})
