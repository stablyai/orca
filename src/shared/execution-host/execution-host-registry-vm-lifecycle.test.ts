import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from './execution-host-registry'
import { getEphemeralVmHostState, getExecutionHostVmStateHealth } from './execution-host-health'
import type { EphemeralVmRuntimeStatus } from '../ephemeral-vm-runtimes'
import type { RuntimeEnvironmentStatus } from '../remote-runtime/host-status/runtime-host-status'

function registryFor(
  status: EphemeralVmRuntimeStatus,
  options: { waking?: boolean; runtimeStatus?: RuntimeEnvironmentStatus } = {}
) {
  return buildExecutionHostRegistry({
    repos: [],
    settings: { activeRuntimeEnvironmentId: null },
    runtimeEnvironments: [{ id: 'vm-env', name: 'VM workspace' }],
    ...(options.runtimeStatus
      ? { runtimeStatusByEnvironmentId: new Map([['vm-env', options.runtimeStatus]]) }
      : {}),
    ephemeralVmHosts: [{ runtimeEnvironmentId: 'vm-env', status, waking: options.waking ?? false }]
  }).find((host) => host.id === 'runtime:vm-env')
}

describe('VM lifecycle host health', () => {
  it.each([
    ['provisioning', false, 'provisioning'],
    ['suspended', false, 'suspended'],
    ['suspended', true, 'waking'],
    ['resume_failed', false, 'resume_failed'],
    ['resume_failed', true, 'waking'],
    ['suspend_failed', false, null],
    ['suspend_failed', true, 'waking'],
    ['running', false, null],
    ['running', true, null],
    ['failed', false, 'provision_failed'],
    ['failed', true, 'provision_failed'],
    ['provisioning', true, 'provisioning'],
    ['cleanup_pending', false, null],
    ['cleanup_failed', false, null],
    ['cleaned', false, null]
  ] as const)('maps %s (waking=%s) to %s', (status, waking, expected) => {
    expect(getEphemeralVmHostState(status, waking)).toBe(expected)
  })

  it('maps resume failure to error health', () => {
    expect(getExecutionHostVmStateHealth('resume_failed')).toBe('error')
  })

  it('maps a failed or interrupted create to error health', () => {
    expect(getExecutionHostVmStateHealth('provision_failed')).toBe('error')
    expect(registryFor('failed')).toMatchObject({ health: 'error', vmState: 'provision_failed' })
  })

  it('reads a suspended VM host as suspended, not disconnected', () => {
    expect(registryFor('running')).toMatchObject({ health: 'connecting' })
    expect(registryFor('running')?.vmState).toBeUndefined()
    expect(registryFor('suspended')).toMatchObject({ health: 'suspended', vmState: 'suspended' })
  })

  it('shows waking while a resume is in flight', () => {
    expect(registryFor('suspended', { waking: true })).toMatchObject({
      health: 'waking',
      vmState: 'waking'
    })
  })

  it('shows resume failure as error with its VM state', () => {
    expect(registryFor('resume_failed')).toMatchObject({
      health: 'error',
      vmState: 'resume_failed'
    })
  })

  it('drops a stale blocked reason when the VM explains the host', () => {
    const host = registryFor('suspended', {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only snapshot transport/verification/blockedReason.
      runtimeStatus: {
        snapshot: {
          transport: 'disconnected',
          verification: 'blocked',
          blockedReason: 'access-revoked'
        }
      } as unknown as RuntimeEnvironmentStatus
    })
    expect(host).toMatchObject({ health: 'suspended' })
    expect(host?.blockedReason).toBeUndefined()
  })

  it('lets a server that answers outrank a stale suspended record', () => {
    const host = registryFor('suspended', {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only snapshot transport/verification.
      runtimeStatus: {
        snapshot: { transport: 'ready', verification: 'verified' }
      } as unknown as RuntimeEnvironmentStatus
    })
    expect(host).toMatchObject({ health: 'available' })
    expect(host?.vmState).toBeUndefined()
  })

  it('keeps a blocked server blocked, with its reason, whatever the VM record says', () => {
    const host = registryFor('suspended', {
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the registry reads only snapshot transport/verification/blockedReason.
      runtimeStatus: {
        snapshot: { transport: 'ready', verification: 'blocked', blockedReason: 'access-revoked' }
      } as unknown as RuntimeEnvironmentStatus
    })
    expect(host).toMatchObject({ health: 'blocked', blockedReason: 'access-revoked' })
    expect(host?.vmState).toBeUndefined()
  })

  it('ignores VM records whose server is not a registry host', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: { activeRuntimeEnvironmentId: null },
      ephemeralVmHosts: [{ runtimeEnvironmentId: 'unknown', status: 'suspended', waking: false }]
    })
    expect(hosts.map((host) => host.id)).toEqual(['local'])
  })
})
