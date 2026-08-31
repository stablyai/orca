import { describe, expect, it } from 'vitest'
import { buildWorkspaceSessionPayload, type WorkspaceSessionSnapshot } from './workspace-session'
import { worktreeWorkspaceKey } from '../../../shared/workspace-scope'

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
    remoteBrowserPageHandlesByPageId: {},
    activeBrowserTabIdByWorktree: {},
    browserUrlHistory: [],
    workspaceDocHistory: [],
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
    closedTerminalTabTombstonesByTabId: {},
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

  it('resolves canonical worktree session keys when persisting SSH PTYs', () => {
    const rawWorktreeId = 'repo-ssh::/remote/canonical-worktree'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [worktreeWorkspaceKey(rawWorktreeId)]: [
            {
              id: 'tab-ssh-canonical',
              title: 'remote',
              ptyId: null,
              worktreeId: rawWorktreeId
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh-canonical': [] },
        lastKnownRelayPtyIdByTabId: {
          'tab-ssh-canonical': 'ssh:conn-1@@pty-canonical'
        },
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
          'repo-ssh': [{ id: rawWorktreeId, repoId: 'repo-ssh' } as never]
        }
      })
    )

    expect(payload.remoteSessionIdsByTabId).toEqual({
      'tab-ssh-canonical': 'ssh:conn-1@@pty-canonical'
    })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['conn-1'])
  })

  it('classifies a canonical SSH session from its repo id when the worktree catalog is cold', () => {
    const rawWorktreeId = 'repo-ssh::/remote/cold-start-worktree'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [worktreeWorkspaceKey(rawWorktreeId)]: [
            {
              id: 'tab-ssh-cold-start',
              title: 'remote',
              ptyId: null,
              worktreeId: rawWorktreeId
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh-cold-start': [] },
        lastKnownRelayPtyIdByTabId: {
          'tab-ssh-cold-start': 'ssh:conn-1@@pty-cold-start'
        },
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
        // Deliberately empty: a cold-start SSH catalog may not have fetched
        // worktrees before the renderer persists during shutdown.
        worktreesByRepo: {}
      })
    )

    expect(payload.remoteSessionIdsByTabId).toEqual({
      'tab-ssh-cold-start': 'ssh:conn-1@@pty-cold-start'
    })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['conn-1'])
  })

  it('normalizes an encoded repo connection id before validating a persisted SSH PTY', () => {
    const rawWorktreeId = 'repo-ssh::/remote/encoded-target'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [rawWorktreeId]: [
            {
              id: 'tab-ssh-encoded-target',
              title: 'remote',
              ptyId: null,
              worktreeId: rawWorktreeId
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh-encoded-target': [] },
        lastKnownRelayPtyIdByTabId: {
          'tab-ssh-encoded-target': 'ssh:target%20with%20spaces@@pty-encoded'
        },
        sshConnectionStates: new Map([['target with spaces', { status: 'reconnecting' } as never]]),
        repos: [
          {
            id: 'repo-ssh',
            path: '/repo-ssh',
            displayName: 'SSH',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: 'ssh:target%20with%20spaces'
          }
        ],
        worktreesByRepo: {
          'repo-ssh': [{ id: rawWorktreeId, repoId: 'repo-ssh' } as never]
        }
      })
    )

    expect(payload.remoteSessionIdsByTabId).toEqual({
      'tab-ssh-encoded-target': 'ssh:target%20with%20spaces@@pty-encoded'
    })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['target with spaces'])
  })

  it('classifies an SSH session from executionHostId when connectionId is absent', () => {
    const rawWorktreeId = 'repo-ssh::/remote/execution-host-only'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [rawWorktreeId]: [
            {
              id: 'tab-ssh-execution-host-only',
              title: 'remote',
              ptyId: null,
              worktreeId: rawWorktreeId
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh-execution-host-only': [] },
        lastKnownRelayPtyIdByTabId: {
          'tab-ssh-execution-host-only': 'ssh:target%20with%20spaces@@pty-host-only'
        },
        sshConnectionStates: new Map([['target with spaces', { status: 'reconnecting' } as never]]),
        repos: [
          {
            id: 'repo-ssh',
            path: '/repo-ssh',
            displayName: 'SSH',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: null,
            executionHostId: 'ssh:target%20with%20spaces'
          }
        ],
        worktreesByRepo: {
          'repo-ssh': [{ id: rawWorktreeId, repoId: 'repo-ssh' } as never]
        }
      })
    )

    expect(payload.remoteSessionIdsByTabId).toEqual({
      'tab-ssh-execution-host-only': 'ssh:target%20with%20spaces@@pty-host-only'
    })
    expect(payload.activeConnectionIdsAtShutdown).toEqual(['target with spaces'])
  })

  it('drops a persisted SSH session whose embedded target disagrees with its worktree owner', () => {
    const worktreeId = 'repo-ssh::/remote/mismatched-target'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [worktreeId]: [
            {
              id: 'tab-ssh-mismatch',
              title: 'remote',
              ptyId: null,
              worktreeId
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ssh-mismatch': [] },
        lastKnownRelayPtyIdByTabId: {
          'tab-ssh-mismatch': 'ssh:ssh-target-b@@pty-mismatch'
        },
        sshConnectionStates: new Map([
          ['ssh-target-a', { status: 'reconnecting' } as never],
          ['ssh-target-b', { status: 'reconnecting' } as never]
        ]),
        repos: [
          {
            id: 'repo-ssh',
            path: '/repo-ssh',
            displayName: 'SSH',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: 'ssh-target-a'
          }
        ],
        worktreesByRepo: {
          'repo-ssh': [
            {
              id: worktreeId,
              repoId: 'repo-ssh',
              hostId: 'ssh:ssh-target-a'
            } as never
          ]
        }
      })
    )

    expect(payload.remoteSessionIdsByTabId).toBeUndefined()
    expect(payload.activeConnectionIdsAtShutdown).toBeUndefined()
  })

  it.each(['worktree:repo-ssh', 'worktree:repo-ssh::'])(
    'does not persist relay sessions for malformed canonical key %s',
    (malformedKey) => {
      const payload = buildWorkspaceSessionPayload(
        createSnapshot({
          tabsByWorktree: {
            [malformedKey]: [
              {
                id: 'tab-malformed-canonical',
                title: 'remote',
                ptyId: null,
                worktreeId: malformedKey
              } as never
            ]
          },
          ptyIdsByTabId: { 'tab-malformed-canonical': [] },
          lastKnownRelayPtyIdByTabId: {
            'tab-malformed-canonical': 'ssh:conn-1@@pty-malformed'
          },
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
          worktreesByRepo: {}
        })
      )

      expect(payload.remoteSessionIdsByTabId).toBeUndefined()
      expect(payload.activeConnectionIdsAtShutdown).toBeUndefined()
    }
  )

  it('does not guess a remote owner when a cold catalog has colliding local and SSH repos', () => {
    const rawWorktreeId = 'repo-collision::/remote/cold-start-worktree'
    const payload = buildWorkspaceSessionPayload(
      createSnapshot({
        tabsByWorktree: {
          [worktreeWorkspaceKey(rawWorktreeId)]: [
            {
              id: 'tab-ambiguous',
              title: 'remote',
              ptyId: null,
              worktreeId: rawWorktreeId
            } as never
          ]
        },
        ptyIdsByTabId: { 'tab-ambiguous': [] },
        lastKnownRelayPtyIdByTabId: { 'tab-ambiguous': 'relay-session-ambiguous' },
        sshConnectionStates: new Map([['conn-1', { status: 'reconnecting' } as never]]),
        repos: [
          {
            id: 'repo-collision',
            path: '/local/repo-collision',
            displayName: 'Local collision',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: null
          },
          {
            id: 'repo-collision',
            path: '/remote/repo-collision',
            displayName: 'SSH collision',
            badgeColor: '#fff',
            addedAt: 1,
            connectionId: 'conn-1'
          }
        ],
        worktreesByRepo: {}
      })
    )

    expect(payload.remoteSessionIdsByTabId).toBeUndefined()
    expect(payload.activeConnectionIdsAtShutdown).toBeUndefined()
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
