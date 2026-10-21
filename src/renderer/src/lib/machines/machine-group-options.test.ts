import { describe, expect, it } from 'vitest'
import type { MachineProviderSnapshot, MachineRecord } from '../../../../shared/machine-inventory'
import { buildMachineGroupOptions } from './machine-group-options'
import { findMachineForHost } from './machine-host-match'

const PROVIDER = 'plugin:omarchy/omarchy' as const

function record(id: string, overrides: Partial<MachineRecord> = {}): MachineRecord {
  return {
    id,
    name: id,
    lifetime: 'persistent',
    state: 'running',
    createdAt: '2026-10-01T00:00:00.000Z',
    providerKey: PROVIDER,
    lastSeenAt: 0,
    ...overrides
  }
}

function snapshot(
  machines: MachineRecord[],
  overrides: Partial<MachineProviderSnapshot> = {}
): MachineProviderSnapshot {
  return {
    providerKey: PROVIDER,
    name: 'Omarchy',
    machines,
    pendingCreates: [],
    capabilities: { verbs: ['create', 'wake', 'sleep'], lifetimes: ['persistent'] },
    ...overrides
  }
}

describe('buildMachineGroupOptions', () => {
  it('leads with machines the project runs on, then the newest, and drops Gone', () => {
    const [group] = buildMachineGroupOptions({
      snapshots: [
        snapshot([
          record('old', { createdAt: '2026-01-01T00:00:00.000Z' }),
          record('new', { createdAt: '2026-09-01T00:00:00.000Z' }),
          record('bound', { createdAt: '2025-01-01T00:00:00.000Z' }),
          record('gone', { state: 'gone', sshTargetId: 'machine-b' }),
          record('stored', { state: 'archived' })
        ])
      ],
      isBound: (_snapshot, machine) => machine.id === 'bound'
    })
    expect(group.machines.map((machine) => machine.name)).toEqual(['bound', 'new', 'old'])
    expect(group.archived.map((machine) => machine.name)).toEqual(['stored'])
  })

  it('maps provider failures to the one row that fixes them', () => {
    const status = (code: NonNullable<MachineProviderSnapshot['lastFailure']>['code']) =>
      buildMachineGroupOptions({
        snapshots: [snapshot([], { lastFailure: { code, message: 'x', at: 1 }, listedAt: 5 })],
        isBound: () => false
      })[0].status
    expect(status('auth-required')).toEqual({ kind: 'sign-in' })
    expect(status('context-mismatch')).toEqual({ kind: 'different-account' })
    expect(status('invalid-response')).toEqual({ kind: 'invalid-response' })
    expect(status('timeout')).toEqual({ kind: 'unreachable', lastSeenAt: 5 })
  })

  it('offers create only for this app’s providers that support it', () => {
    const canCreate = (
      verbs: ('create' | 'wake')[],
      environment: { id: string; name: string } | null
    ) =>
      buildMachineGroupOptions({
        snapshots: [snapshot([], { capabilities: { verbs, lifetimes: ['temporary'] } })],
        isBound: () => false,
        environment
      })[0].canCreate
    expect(canCreate(['create'], null)).toBe(true)
    expect(canCreate(['wake'], null)).toBe(false)
    expect(canCreate(['create'], { id: 'env-2', name: 'build-box' })).toBe(false)
  })
})

describe('findMachineForHost', () => {
  const self = [
    snapshot([
      record('ssh-box', { sshTargetId: 'machine-a', managedEnvironmentId: 'env-ssh' }),
      record('server-box', { runtimeEnvironmentId: 'env-1' })
    ])
  ]
  const remote = [snapshot([record('remote-box', { sshTargetId: 'machine-a' })])]
  const sources = { self, environments: { 'env-2': remote } }

  it('matches this app’s SSH and Orca-server machines by host id', () => {
    expect(findMachineForHost('ssh:machine-a', sources)?.machine.name).toBe('ssh-box')
    expect(findMachineForHost('runtime:env-1', sources)?.machine.name).toBe('server-box')
  })

  it('follows a managed server back to the SSH machine it was deployed on', () => {
    expect(findMachineForHost('runtime:env-ssh', sources)?.machine.name).toBe('ssh-box')
  })

  it('reads a paired server’s SSH target only from that server’s inventory', () => {
    expect(findMachineForHost('nested:env-2/machine-a', sources)?.machine.name).toBe('remote-box')
    expect(findMachineForHost('nested:env-3/machine-a', sources)).toBeNull()
  })

  it('ignores hosts no machine owns', () => {
    expect(findMachineForHost('local', sources)).toBeNull()
    expect(findMachineForHost('ssh:dev-box', sources)).toBeNull()
    expect(findMachineForHost(null, sources)).toBeNull()
  })
})
