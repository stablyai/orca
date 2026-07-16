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

  it('reconnects a persisted SSH PTY when shutdown observes a transient relay drop', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-ssh': [
            {
              id: 'tab-ssh',
              title: 'remote',
              ptyId: null,
              worktreeId: 'wt-ssh'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh': [] },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'ssh:conn-1@@pty-42' },
        // Why 'reconnecting': an involuntary transport drop always lands in
        // 'reconnecting' / 'reconnection-failed' / 'error' — never
        // 'disconnected', which only an explicit user disconnect produces.
        sshConnectionStates: new Map([['conn-1', { status: 'reconnecting' } as never]]),
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

    expect(payload.remoteSessionIdsByTabId).toEqual({
      'tab-ssh': 'ssh:conn-1@@pty-42'
    })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['conn-1'])
  })

  it('keeps explicitly disconnected hosts out of the startup reconnect list', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-ssh': [
            {
              id: 'tab-ssh',
              title: 'remote',
              ptyId: null,
              worktreeId: 'wt-ssh'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh': [] },
        lastKnownRelayPtyIdByTabId: { 'tab-ssh': 'ssh:conn-1@@pty-42' },
        // 'disconnected' = the user chose to take this host offline. The
        // session id must still persist (restore-on-focus), but startup must
        // not auto-dial the host against the user's intent.
        sshConnectionStates: new Map([['conn-1', { status: 'disconnected' } as never]]),
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

    expect(payload.remoteSessionIdsByTabId).toEqual({
      'tab-ssh': 'ssh:conn-1@@pty-42'
    })
    expect(payload.activeConnectionIdsAtShutdown).toBeUndefined()
  })

  it('never derives runtime-owned SSH targets into the startup reconnect list', () => {
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          'wt-vm': [
            {
              id: 'tab-vm',
              title: 'vm',
              ptyId: null,
              worktreeId: 'wt-vm'
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-vm': [] },
        lastKnownRelayPtyIdByTabId: { 'tab-vm': 'ssh:runtime-ssh-vm1@@pty-7' },
        // Why a status entry: without one the status gate already excludes the
        // target and the runtime-owned check would be untested dead weight.
        // A pane-driven optimistic write CAN stamp runtime-owned states
        // (TerminalSshReconnectOverlay), so pin the exclusion independently —
        // on both the session-id union path ('reconnecting') and the live
        // connected-states path ('connected').
        sshConnectionStates: new Map([
          ['runtime-ssh-vm1', { status: 'reconnecting' } as never],
          ['runtime-ssh-vm2', { status: 'connected' } as never]
        ]),
        repos: [
          {
            id: 'repo-vm',
            path: '/repo-vm',
            displayName: 'VM',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: 'runtime-ssh-vm1'
          }
        ],
        worktreesByRepo: {
          'repo-vm': [{ id: 'wt-vm', repoId: 'repo-vm' } as never]
        }
      })
    )

    // Why: the renderer must never drive startup ssh.connect for runtime-owned
    // (ephemeral-VM) targets — their lifecycle belongs to the runtime layer,
    // and ssh.listTargets() hides them so the connect would target a host the
    // user cannot see or manage.
    expect(payload.remoteSessionIdsByTabId).toEqual({
      'tab-vm': 'ssh:runtime-ssh-vm1@@pty-7'
    })
    expect(payload.activeConnectionIdsAtShutdown).toBeUndefined()
  })
})
