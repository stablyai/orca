import { describe, expect, it } from 'vitest'
import { buildExecutionHostRegistry } from './execution-host-registry'
import {
  expandEquivalentExecutionHostIds,
  indexExecutionHostsById,
  pickerExecutionHosts,
  widenSavedExecutionHostIds
} from './managed-orcad-execution-host'
import type { SshConnectionState } from './ssh-types'

const SSH_TARGETS = new Map([['omarchy-target', 'Omarchy']])
const MANAGED_SERVER = {
  id: 'omarchy-server',
  name: 'Omarchy server',
  orcadDeployment: { sshTargetId: 'omarchy-target' }
}

function connectionStates(
  managedServer: SshConnectionState['managedServer']
): Map<string, SshConnectionState> {
  return new Map([
    [
      'omarchy-target',
      {
        targetId: 'omarchy-target',
        status: 'connected',
        error: null,
        reconnectAttempt: 0,
        managedServer
      }
    ]
  ])
}

function registry(managedServer?: SshConnectionState['managedServer']) {
  return buildExecutionHostRegistry({
    repos: [],
    settings: null,
    hostSource: 'configured-only',
    sshTargetLabels: SSH_TARGETS,
    sshConnectionStates: managedServer ? connectionStates(managedServer) : undefined,
    runtimeEnvironments: [MANAGED_SERVER]
  })
}

describe('managed Orca server host merging', () => {
  it('keeps both ids resolvable and shows one row routed to the server', () => {
    const hosts = registry({ kind: 'managed', environmentId: 'omarchy-server' })

    // Why both: setups, folders and filters are owned by one id or the other.
    expect(hosts.map((host) => host.id)).toEqual([
      'local',
      'runtime:omarchy-server',
      'ssh:omarchy-target'
    ])
    expect(pickerExecutionHosts(hosts).map((host) => [host.id, host.label, host.detail])).toEqual([
      ['local', expect.any(String), 'This computer'],
      ['runtime:omarchy-server', 'Omarchy', 'SSH']
    ])
    expect(hosts[1]?.aliasHostIds).toEqual(['ssh:omarchy-target'])
    expect(hosts[2]).toMatchObject({
      label: 'Omarchy',
      mergedIntoHostId: 'runtime:omarchy-server'
    })
  })

  it('routes to the server before main reports a route', () => {
    expect(pickerExecutionHosts(registry()).map((host) => host.id)).toEqual([
      'local',
      'runtime:omarchy-server'
    ])
  })

  it('shows the SSH id when main reports the host on its relay', () => {
    const hosts = registry({ kind: 'relay', reason: 'source_changed' })

    expect(pickerExecutionHosts(hosts).map((host) => [host.id, host.label])).toEqual([
      ['local', expect.any(String)],
      ['ssh:omarchy-target', 'Omarchy']
    ])
    expect(hosts.find((host) => host.id === 'runtime:omarchy-server')?.mergedIntoHostId).toBe(
      'ssh:omarchy-target'
    )
  })

  it('keeps a manually paired server that no SSH host deployed', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: SSH_TARGETS,
      runtimeEnvironments: [{ id: 'paired-server', name: 'Omarchy' }]
    })

    expect(pickerExecutionHosts(hosts).map((host) => host.id)).toEqual([
      'local',
      'runtime:paired-server',
      'ssh:omarchy-target'
    ])
  })

  it('keeps an orphaned managed server whose SSH host was removed', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: new Map(),
      runtimeEnvironments: [MANAGED_SERVER]
    })

    expect(pickerExecutionHosts(hosts).map((host) => [host.id, host.label])).toEqual([
      ['local', expect.any(String)],
      ['runtime:omarchy-server', 'Omarchy server']
    ])
    expect(hosts[1]?.aliasHostIds).toBeUndefined()
  })

  it.each([
    ['managed', { kind: 'managed', environmentId: 'omarchy-server' } as const],
    ['relay', { kind: 'relay', reason: 'source_changed' } as const]
  ])('resolves a selection saved under either id to the %s row', (_route, managedServer) => {
    const hosts = registry(managedServer)
    const shownId = managedServer.kind === 'relay' ? 'ssh:omarchy-target' : 'runtime:omarchy-server'
    const byId = indexExecutionHostsById(hosts)

    expect(byId.get('runtime:omarchy-server')?.id).toBe(shownId)
    expect(byId.get('ssh:omarchy-target')?.id).toBe(shownId)
    expect(byId.get('runtime:omarchy-server')?.label).toBe('Omarchy')
    expect(new Set(expandEquivalentExecutionHostIds(hosts, [shownId]))).toEqual(
      new Set(['runtime:omarchy-server', 'ssh:omarchy-target'])
    )
  })

  it('names the merged row with a rename saved on either id', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [],
      settings: null,
      hostSource: 'configured-only',
      sshTargetLabels: SSH_TARGETS,
      runtimeEnvironments: [MANAGED_SERVER],
      hostLabelOverrides: new Map([['ssh:omarchy-target', 'Build box']])
    })

    expect(hosts.find((host) => host.id === 'runtime:omarchy-server')?.label).toBe('Build box')
  })

  it('widens a host scope an older build saved with only one id of the pair', () => {
    const hosts = registry({ kind: 'managed', environmentId: 'omarchy-server' })

    expect(new Set(widenSavedExecutionHostIds(hosts, ['local', 'ssh:omarchy-target']))).toEqual(
      new Set(['local', 'ssh:omarchy-target', 'runtime:omarchy-server'])
    )
    expect(
      widenSavedExecutionHostIds(hosts, ['ssh:omarchy-target', 'runtime:omarchy-server'])
    ).toBeNull()
    expect(widenSavedExecutionHostIds(hosts, ['local'])).toBeNull()
    expect(widenSavedExecutionHostIds(hosts, null)).toBeNull()
  })
})
