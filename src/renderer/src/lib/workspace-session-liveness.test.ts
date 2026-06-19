import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPayload, type WorkspaceSessionSnapshot } from './workspace-session'

function createSnapshot(
  overrides: Partial<WorkspaceSessionSnapshot> = {}
): WorkspaceSessionSnapshot {
  return {
    activeRepoId: 'repo-1',
    activeWorkspaceKey: 'worktree:wt-1',
    activeWorktreeId: 'wt-1',
    activeTabId: 'tab-1',
    tabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    activeTabIdByWorktree: {},
    openFiles: [],
    editorDrafts: {},
    markdownFrontmatterVisible: {},
    activeFileIdByWorktree: {},
    activeTabTypeByWorktree: {},
    browserTabsByWorktree: {},
    browserPagesByWorkspace: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    unifiedTabsByWorktree: {},
    groupsByWorktree: {},
    layoutByWorktree: {},
    activeGroupIdByWorktree: {},
    sshConnectionStates: new Map(),
    repos: [],
    worktreesByRepo: {},
    lastKnownRelayPtyIdByTabId: {},
    lastVisitedAtByWorktreeId: {},
    defaultTerminalTabsAppliedByWorktreeId: {},
    ...overrides
  }
}

describe('workspace session live PTY persistence', () => {
  it('does not treat slept terminal wake hints as active on restart', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-1': [
            {
              id: 'tab-1',
              title: 'shell',
              ptyId: 'preserved-wake-hint',
              worktreeId: 'wt-1'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-1': [] }
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toEqual([])
  })

  it('does not persist remote session ids for slept SSH tabs', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-ssh': [
            {
              id: 'tab-ssh',
              title: 'remote',
              ptyId: 'relay-sess-42',
              worktreeId: 'wt-ssh'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh': [] },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'relay-sess-42' },
        repos: [
          {
            id: 'repo-ssh',
            path: '/repo-ssh',
            displayName: 'SSH',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: 'conn-1'
          }
        ],
        worktreesByRepo: {
          'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' } as never]
        }
      })
    )

    expect(payload.activeWorktreeIdsOnShutdown).toEqual([])
    expect(payload.remoteSessionIdsByTabId).toBeUndefined()
  })
})
