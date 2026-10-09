import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { selectWorktreeHostConnectionPhase } from '@/lib/worktree-host-connection-phase'
import { selectTerminalPaneHostState } from './terminal-pane-host-state'

function makeState(overrides: Record<string, unknown>): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: fixture supplies the slices host-state resolution reads.
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

  // Without this the terminal overlay shows only a canned sentence, so a host key rejection — whose
  // remedy is the last clause of the message — is invisible to anyone working in a terminal.
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

  // The terminal reads the shared host signal but names the published status: an undialed
  // target during startup restoration stays "disconnected" here (the overlay and error
  // ownership are unchanged) even though the other panes read that window as connecting.
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

  // An owning runtime that has not published its SSH state is unverifiable, not down: the
  // terminal keeps reporting no status, so it shows no reconnect overlay for it.
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

  it("carries the pane repo's terminal theme and re-publishes only when it changes", () => {
    const terminalTheme = { dark: 'Dracula' }
    const repos = [{ id: 'repo-theme', terminalTheme }]
    const worktreesByRepo = { 'repo-theme': [{ id: 'repo-theme::/wt', repoId: 'repo-theme' }] }
    const first = selectTerminalPaneHostState(
      makeState({ repos, worktreesByRepo }),
      'repo-theme::/wt'
    )
    expect(first.repoTerminalTheme).toBe(terminalTheme)
    // A new store publication with the same repo rows keeps the memoized identity.
    expect(
      selectTerminalPaneHostState(makeState({ repos, worktreesByRepo }), 'repo-theme::/wt')
    ).toBe(first)
    const nextTheme = { dark: 'Nord' }
    const changed = selectTerminalPaneHostState(
      makeState({ repos: [{ id: 'repo-theme', terminalTheme: nextTheme }], worktreesByRepo }),
      'repo-theme::/wt'
    )
    expect(changed).not.toBe(first)
    expect(changed.repoTerminalTheme).toBe(nextTheme)
  })

  it('keeps the theme object when only the SSH status changes', () => {
    const terminalTheme = { dark: 'Dracula' }
    const withStatus = (status: string) =>
      makeState({
        repos: [{ id: 'repo-ssh-theme', connectionId: 'ssh-b', terminalTheme }],
        sshConnectionStates: new Map([
          ['ssh-b', { targetId: 'ssh-b', status, error: null, reconnectAttempt: 0 }]
        ]),
        worktreesByRepo: {
          'repo-ssh-theme': [{ id: 'repo-ssh-theme::/wt', repoId: 'repo-ssh-theme' }]
        }
      })
    const connected = selectTerminalPaneHostState(withStatus('connected'), 'repo-ssh-theme::/wt')
    const connecting = selectTerminalPaneHostState(withStatus('connecting'), 'repo-ssh-theme::/wt')
    expect(connecting).not.toBe(connected)
    expect(connecting.repoTerminalTheme).toBe(connected.repoTerminalTheme)
  })
})
