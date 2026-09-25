import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import type { SshConnectionStatus } from '../../../shared/ssh-types'
import { selectWorktreeHostConnectionPhase } from './worktree-host-connection-phase'

function makeState(overrides: Record<string, unknown>): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the phase selector reads only the repo, worktree, runtime, and SSH fields set here.
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
    terminalStartupRestorationReady: true,
    worktreesByRepo: {},
    ...overrides
  } as unknown as AppState
}

function makeSshState(
  status: SshConnectionStatus | null,
  overrides: Record<string, unknown> = {}
): AppState {
  return makeState({
    repos: [{ id: 'repo-ssh', connectionId: 'ssh-a' }],
    sshConnectionStates: new Map(
      status
        ? [
            [
              'ssh-a',
              {
                targetId: 'ssh-a',
                status,
                error: null,
                reconnectAttempt: 0,
                connectionGeneration: 7
              }
            ]
          ]
        : []
    ),
    worktreesByRepo: { 'repo-ssh': [{ id: 'wt-ssh', repoId: 'repo-ssh' }] },
    ...overrides
  })
}

describe('selectWorktreeHostConnectionPhase', () => {
  it('reports a local workspace, and no worktree, as local', () => {
    const state = makeState({
      repos: [{ id: 'repo-local' }],
      worktreesByRepo: { 'repo-local': [{ id: 'wt-local', repoId: 'repo-local' }] }
    })

    const local = { phase: 'local', targetId: null, connectionGeneration: null }
    expect(selectWorktreeHostConnectionPhase(state, 'wt-local')).toEqual(local)
    expect(selectWorktreeHostConnectionPhase(state, null)).toEqual(local)
  })

  it('reports a runtime-owned target as local: this client never dials it', () => {
    const state = makeState({
      repos: [{ id: 'repo-ephemeral', connectionId: 'runtime-ssh-vm-a' }],
      worktreesByRepo: { 'repo-ephemeral': [{ id: 'wt-ephemeral', repoId: 'repo-ephemeral' }] }
    })

    expect(selectWorktreeHostConnectionPhase(state, 'wt-ephemeral').phase).toBe('local')
  })

  it('reads an unpublished target as connecting only until startup restoration finishes', () => {
    expect(
      selectWorktreeHostConnectionPhase(
        makeSshState(null, { terminalStartupRestorationReady: false }),
        'wt-ssh'
      )
    ).toEqual({ phase: 'connecting', targetId: 'ssh-a', connectionGeneration: null })
    expect(selectWorktreeHostConnectionPhase(makeSshState(null), 'wt-ssh')).toEqual({
      phase: 'unavailable',
      targetId: 'ssh-a',
      connectionGeneration: null
    })
  })

  it('maps published statuses and carries the connection generation', () => {
    expect(selectWorktreeHostConnectionPhase(makeSshState('connecting'), 'wt-ssh')).toEqual({
      phase: 'connecting',
      targetId: 'ssh-a',
      connectionGeneration: 7
    })
    expect(selectWorktreeHostConnectionPhase(makeSshState('reconnecting'), 'wt-ssh').phase).toBe(
      'connecting'
    )
    expect(selectWorktreeHostConnectionPhase(makeSshState('deploying-relay'), 'wt-ssh').phase).toBe(
      'connecting'
    )
    expect(selectWorktreeHostConnectionPhase(makeSshState('connected'), 'wt-ssh')).toEqual({
      phase: 'connected',
      targetId: 'ssh-a',
      connectionGeneration: 7
    })
  })

  it('reports failed and disconnected targets as unavailable once restoration is done', () => {
    for (const status of ['reconnection-failed', 'disconnected', 'auth-failed', 'error'] as const) {
      expect(selectWorktreeHostConnectionPhase(makeSshState(status), 'wt-ssh').phase).toBe(
        'unavailable'
      )
    }
  })

  it('keeps a published failure unavailable even before restoration finishes', () => {
    expect(
      selectWorktreeHostConnectionPhase(
        makeSshState('auth-failed', { terminalStartupRestorationReady: false }),
        'wt-ssh'
      ).phase
    ).toBe('unavailable')
  })

  it("reads a runtime environment's nested target from that environment's SSH state", () => {
    const state = makeState({
      repos: [{ id: 'repo-runtime', connectionId: 'ssh-nested', executionHostId: 'runtime:env-a' }],
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
                  status: 'connected',
                  error: null,
                  reconnectAttempt: 0,
                  connectionGeneration: 3
                }
              ]
            ]),
            targetLabels: new Map([['ssh-nested', 'build box']]),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ]),
      terminalStartupRestorationReady: false,
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

    expect(selectWorktreeHostConnectionPhase(state, 'wt-runtime')).toEqual({
      phase: 'connected',
      targetId: 'ssh-nested',
      connectionGeneration: 3
    })
  })
})
