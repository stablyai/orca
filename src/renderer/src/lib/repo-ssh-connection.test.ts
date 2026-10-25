import { describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../shared/repo-types'
import type { SshConnectionState, SshConnectionStatus } from '../../../shared/ssh-types'
import { getRepoHeaderCreateState } from '@/components/sidebar/repo-header-create-state'

vi.mock('@/runtime/runtime-environment-ssh-state', () => ({
  connectRuntimeEnvironmentSshTarget: vi.fn()
}))

const { getRepoSshConnection, selectRepoSshGateInput } = await import('./repo-ssh-connection')

function repo(overrides: Partial<Repo>): Repo {
  return {
    id: 'r',
    path: '/srv/dike',
    displayName: 'dike',
    badgeColor: '#999',
    addedAt: 1,
    ...overrides
  }
}

function sshState(status: SshConnectionStatus): SshConnectionState {
  return { targetId: 'ssh-dike', status, error: null, reconnectAttempt: 0 }
}

// The server's target `ssh-dike` is never in this client's own map.
function state(options: {
  serverStatus?: SshConnectionStatus
  hydrated?: boolean
  reachable?: boolean
}) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store fixture; the selector reads only the SSH maps and the status entry built here.
  return {
    sshConnectionStates: new Map<string, SshConnectionState>(),
    sshTargetLabels: new Map<string, string>(),
    removedSshTargetLabels: new Map<string, string>(),
    sshTargetsHydrated: true,
    sshStateByEnvironment: new Map([
      [
        'env-1',
        {
          connectionStates: new Map(
            options.serverStatus ? [['ssh-dike', sshState(options.serverStatus)]] : []
          ),
          targetLabels: new Map([['ssh-dike', 'dike']]),
          targetGenerations: new Map(),
          removedTargetLabels: new Map(),
          targetsHydrated: options.hydrated ?? true
        }
      ]
    ]),
    runtimeStatusByEnvironmentId: new Map([
      ['env-1', options.reachable === false ? { status: null } : { checkedAt: 1, status: {} }]
    ])
  } as unknown as Parameters<typeof selectRepoSshGateInput>[0]
}

const serverRepo = repo({ connectionId: 'ssh-dike', executionHostId: 'runtime:env-1' })

describe("a project on a paired server's own SSH target (#25887)", () => {
  it('names the server and its target', () => {
    expect(getRepoSshConnection(serverRepo)).toEqual({
      environmentId: 'env-1',
      targetId: 'ssh-dike'
    })
    expect(getRepoSshConnection(repo({ connectionId: 'ssh-mine' }))).toEqual({
      environmentId: null,
      targetId: 'ssh-mine'
    })
    expect(getRepoSshConnection(repo({ executionHostId: 'runtime:env-1' }))).toBeNull()
  })

  it('allows creating a workspace when the server reports its target connected', () => {
    const sshGate = selectRepoSshGateInput(state({ serverStatus: 'connected' }), serverRepo)

    expect(getRepoHeaderCreateState({ repo: serverRepo, label: 'dike', sshGate })).toMatchObject({
      disabled: false
    })
  })

  it('asks to reconnect when the server reports its target disconnected', () => {
    const sshGate = selectRepoSshGateInput(state({ serverStatus: 'disconnected' }), serverRepo)

    expect(sshGate).toEqual({ connectionId: 'ssh-dike', status: 'disconnected' })
    expect(getRepoHeaderCreateState({ repo: serverRepo, label: 'dike', sshGate })).toMatchObject({
      disabled: true,
      requiresSshReconnect: true
    })
  })

  it('leaves an unverifiable target to the server instead of blocking with a dead reconnect', () => {
    for (const unverifiable of [{ hydrated: false }, { reachable: false }]) {
      const sshGate = selectRepoSshGateInput(
        state({ serverStatus: 'disconnected', ...unverifiable }),
        serverRepo
      )
      expect(sshGate).toEqual({ connectionId: null, status: null })
    }
  })

  it("keeps reading this client's own map for its own SSH projects", () => {
    const local = repo({ connectionId: 'ssh-mine' })
    const base = state({})
    base.sshConnectionStates.set('ssh-mine', { ...sshState('connected'), targetId: 'ssh-mine' })

    expect(selectRepoSshGateInput(base, local)).toEqual({
      connectionId: 'ssh-mine',
      status: 'connected'
    })
  })
})
