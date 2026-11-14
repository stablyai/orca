import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from './execution-host-registry'
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
})
