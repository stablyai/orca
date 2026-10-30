import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { selectWorktreeHostConnectionPhase } from '@/lib/worktree-host-connection-phase'
import { selectTerminalPaneHostState } from './terminal-pane-host-state'

function makeState(overrides: Record<string, unknown>): AppState {
  return {
    activeWorktreeId: null,
    detectedWorktreesByRepo: {},
    folderWorkspaces: [],
    projectGroups: [],
    removedSshTargetLabels: new Map(),
    repos: [],
    runtimeStatusByEnvironmentId: new Map(),
    sshConnectionStates: new Map(),
    sshStateByEnvironment: new Map(),
    sshTargetLabels: new Map(),
    sshTargetsHydrated: true,
    worktreesByRepo: {},
    ...overrides
  } as unknown as AppState
}

describe('selectTerminalPaneHostState', () => {
  it('resolves local and direct SSH workspaces without changing reconnect semantics', () => {
    const localState = makeState({
      repos: [{ id: 'repo-local' }],
      worktreesByRepo: {
        'repo-local': [{ id: 'wt-local', repoId: 'repo-local' }]
      }
    })

    expect(selectTerminalPaneHostState(localState, 'wt-local')).toEqual({
      nativeChatTranscriptIsLocalReadable: true,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: null,
      sshReconnectTargetId: null,
      sshReconnectTargetLabel: '',
      sshReconnectTargetRemoved: false
    })

    const sshState = makeState({
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([
        ['ssh-a', { targetId: 'ssh-a', status: 'connected', error: null, reconnectAttempt: 0 }]
      ]),
      sshTargetLabels: new Map([['ssh-a', 'devbox']]),
      worktreesByRepo: {
        'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' }]
      }
    })

    expect(selectTerminalPaneHostState(sshState, 'wt-ssh')).toEqual({
      nativeChatTranscriptIsLocalReadable: false,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: 'connected',
      sshReconnectTargetId: 'ssh-a',
      sshReconnectTargetLabel: 'devbox',
      sshReconnectTargetRemoved: false
    })
  })

  it('reads nested SSH state from the worktree owner runtime', () => {
    const state = makeState({
      repos: [
        {
          id: 'repo-runtime',
          connectionId: 'ssh-nested',
          executionHostId: 'runtime:env-a'
        }
      ],
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', { status: { runtimeId: 'runtime-a' }, checkedAt: 1 }]
      ]),
      sshStateByEnvironment: new Map([
        [
          'env-a',
          {
            connectionStates: new Map([
              [
                'ssh-nested',
                {
                  targetId: 'ssh-nested',
                  status: 'disconnected',
                  error: null,
                  reconnectAttempt: 0
                }
              ]
            ]),
            targetLabels: new Map([['ssh-nested', 'build box']]),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ]),
      worktreesByRepo: {
        'repo-runtime': [
          {
            id: 'wt-runtime',
            repoId: 'repo-runtime',
            hostId: 'runtime:env-a',
            runtimeOwnerEnvironmentId: 'env-a'
          }
        ]
      }
    })

    expect(selectTerminalPaneHostState(state, 'wt-runtime')).toEqual({
      nativeChatTranscriptIsLocalReadable: false,
      sshReconnectEnvironmentId: 'env-a',
      sshReconnectError: null,
      sshReconnectStatus: 'disconnected',
      sshReconnectTargetId: 'ssh-nested',
      sshReconnectTargetLabel: 'build box',
      sshReconnectTargetRemoved: false
    })
  })

  // Expose the host’s detail so terminal overlays include actionable rejection remedies.
  it('carries the failure detail alongside the status', () => {
    const state = makeState({
      repos: [{ id: 'repo-ssh', connectionId: 'ssh-a' }],
      sshConnectionStates: new Map([
        [
          'ssh-a',
          {
            targetId: 'ssh-a',
            status: 'error',
            error: 'Host key verification failed for devbox. Run: ssh-keygen -R devbox',
            reconnectAttempt: 0
          }
        ]
      ]),
      sshTargetLabels: new Map([['ssh-a', 'devbox']]),
      worktreesByRepo: { 'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' }] }
    })

    const host = selectTerminalPaneHostState(state, 'wt-ssh')

    expect(host.sshReconnectStatus).toBe('error')
    expect(host.sshReconnectError).toContain('ssh-keygen -R devbox')
  })

  it('keeps runtime-owned SSH plumbing out of reconnect UI', () => {
    const state = makeState({
      repos: [{ id: 'repo-ephemeral', connectionId: 'runtime-ssh-vm-a' }],
      worktreesByRepo: {
        'repo-ephemeral': [{ id: 'wt-ephemeral', repoId: 'repo-ephemeral' }]
      }
    })

    expect(selectTerminalPaneHostState(state, 'wt-ephemeral')).toEqual({
      nativeChatTranscriptIsLocalReadable: true,
      sshReconnectEnvironmentId: null,
      sshReconnectError: null,
      sshReconnectStatus: null,
      sshReconnectTargetId: null,
      sshReconnectTargetLabel: '',
      sshReconnectTargetRemoved: false
    })
  })

  // Keep published disconnected status during startup; shared connecting hints must not change terminal overlay/error ownership.
  it('reports the published status through the shared signal, across startup and connect', () => {
    const repos = [{ id: 'repo-ssh', connectionId: 'ssh-a' }]
    const worktreesByRepo = { 'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' }] }
    const withStatus = (status: string | null): AppState =>
      makeState({
        repos,
        worktreesByRepo,
        terminalStartupRestorationReady: false,
        sshConnectionStates: new Map(
          status ? [['ssh-a', { targetId: 'ssh-a', status, error: null, reconnectAttempt: 0 }]] : []
        )
      })

    expect(selectWorktreeHostConnectionPhase(withStatus(null), 'wt-ssh').phase).toBe('connecting')
    expect(selectTerminalPaneHostState(withStatus(null), 'wt-ssh').sshReconnectStatus).toBe(
      'disconnected'
    )
    expect(selectTerminalPaneHostState(withStatus('connecting'), 'wt-ssh').sshReconnectStatus).toBe(
      'connecting'
    )
    expect(selectTerminalPaneHostState(withStatus('connected'), 'wt-ssh').sshReconnectStatus).toBe(
      'connected'
    )
  })

  // Missing owner-runtime SSH state is unknown; show no disconnected overlay without evidence.
  it('reports no status for a nested target whose runtime has not published its SSH state', () => {
    const state = makeState({
      repos: [{ id: 'repo-runtime', connectionId: 'ssh-nested', executionHostId: 'runtime:env-a' }],
      runtimeStatusByEnvironmentId: new Map([
        ['env-a', { status: { runtimeId: 'runtime-a' }, checkedAt: 1 }]
      ]),
      sshStateByEnvironment: new Map([
        [
          'env-a',
          {
            connectionStates: new Map(),
            targetLabels: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: false
          }
        ]
      ]),
      worktreesByRepo: {
        'repo-runtime': [
          {
            id: 'wt-runtime',
            repoId: 'repo-runtime',
            hostId: 'runtime:env-a',
            runtimeOwnerEnvironmentId: 'env-a'
          }
        ]
      }
    })

    expect(selectWorktreeHostConnectionPhase(state, 'wt-runtime').phase).toBe('unverifiable')
    expect(selectTerminalPaneHostState(state, 'wt-runtime')).toMatchObject({
      sshReconnectEnvironmentId: 'env-a',
      sshReconnectStatus: null,
      sshReconnectTargetId: 'ssh-nested'
    })
  })
})
