import { describe, expect, it } from 'vitest'

import { buildExecutionHostRegistry } from './execution-host-registry'

describe('execution host registry', () => {
  it('excludes repository references from configured-only registries', () => {
    const hosts = buildExecutionHostRegistry({
      repos: [
        { connectionId: 'removed-ssh' },
        { connectionId: null, executionHostId: 'runtime:removed-runtime' }
      ],
      settings: { activeRuntimeEnvironmentId: 'removed-focused-runtime' },
      hostSource: 'configured-only',
      sshTargetLabels: new Map([['saved-ssh', 'Saved SSH']]),
      runtimeEnvironments: [{ id: 'saved-runtime', name: 'Saved Runtime' }]
    })

    expect(hosts.map((host) => host.id)).toEqual([
      'local',
      'runtime:saved-runtime',
      'ssh:saved-ssh'
    ])
  })

  it('hides runtime-owned (ephemeral VM) SSH targets from repo-derived hosts', () => {
    const hosts = buildExecutionHostRegistry({
      // A VM-backed repo carries the hidden runtime-owned target on both fields.
      repos: [
        {
          connectionId: 'runtime-ssh-orca-instance-1',
          executionHostId: 'ssh:runtime-ssh-orca-instance-1'
        },
        { connectionId: 'repo-ssh' }
      ],
      settings: { activeRuntimeEnvironmentId: null },
      // Stale labels must not reveal hidden runtime targets.
      sshTargetLabels: new Map([['runtime-ssh-orca-instance-1', 'Hidden VM']])
    })

    expect(hosts.some((h) => h.id.includes('runtime-ssh-orca-instance-1'))).toBe(false)
    expect(hosts.some((h) => h.id === 'ssh:repo-ssh')).toBe(true)
  })

  it("does not add a client SSH host from a paired server's nested SSH target", () => {
    const hosts = buildExecutionHostRegistry({
      // The server's own target id; this client has no such SSH host.
      repos: [{ connectionId: 'server-ssh', executionHostId: 'runtime:env-1' }],
      settings: { activeRuntimeEnvironmentId: null },
      sshConnectionStates: new Map([
        [
          'server-ssh',
          { targetId: 'server-ssh', status: 'connected', error: null, reconnectAttempt: 0 }
        ]
      ])
    })

    expect(hosts.map((h) => h.id)).toEqual(['local', 'runtime:env-1'])
  })
})
