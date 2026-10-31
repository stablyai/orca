import { describe, expect, it } from 'vitest'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { getPaletteHostBadge } from './palette-host-badge'
import { buildSidebarHostOptions } from '../sidebar/sidebar-host-options'

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

// Only verified live remotes enable host disambiguation without a filter.
const connectedSshStates = (targetId: string) =>
  new Map([
    [targetId, { targetId, status: 'connected' as const, error: null, reconnectAttempt: 0 }]
  ])

describe('getPaletteHostBadge', () => {
  it('returns null for single-host (local-only) workspaces', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: null }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge('local', hosts)).toBeNull()
  })

  it('returns null when the only non-local host is configured but disconnected', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    // Absent connection state is disconnected; no live remote needs disambiguation.
    expect(getPaletteHostBadge('local', hosts)).toBeNull()
  })

  it('badges a disconnected host anyway when a host filter is applied', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    // Active filters need host labels even when remotes are disconnected.
    expect(getPaletteHostBadge('ssh:ssh-1', hosts, true)).toEqual({
      hostId: 'ssh:ssh-1',
      label: 'Builder'
    })
  })

  it('badges the local host when a connected remote host exists', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      sshConnectionStates: connectedSshStates('ssh-1'),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge('local', hosts)).toEqual({
      hostId: 'local',
      label: LOCAL_HOST_LABEL
    })
  })

  it('uses the ssh target label for ssh repos', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      sshConnectionStates: connectedSshStates('ssh-1'),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge('ssh:ssh-1', hosts)).toEqual({
      hostId: 'ssh:ssh-1',
      label: 'Builder'
    })
  })

  it('badges runtime-hosted repos when the runtime is live', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ executionHostId: 'runtime:env-1' }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: 'env-2' },
      // Only verified availability enables unfiltered host badges.
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-1',
          {
            checkedAt: 0,
            status: {
              runtimeId: 'rt',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: 3,
              minCompatibleRuntimeClientVersion: 3
            }
          }
        ]
      ])
    })

    expect(getPaletteHostBadge('runtime:env-1', hosts)).toEqual({
      hostId: 'runtime:env-1',
      label: 'env-1'
    })
  })

  it('suppresses the badge when the only remote runtime has no live status', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ executionHostId: 'runtime:env-1' }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge('local', hosts)).toBeNull()
  })

  it('returns null when the host is unknown', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      sshConnectionStates: connectedSshStates('ssh-1'),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge(null, hosts)).toBeNull()
  })
})

it.each(['connecting', 'blocked', 'disconnected', 'error'] as const)(
  'does not infer reachability from %s health, but preserves explicit filter labels',
  (health) => {
    const hosts = buildSidebarHostOptions({
      repos: [{ executionHostId: 'runtime:env-1' }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null }
    }).map((host) => (host.kind === 'runtime' ? { ...host, health } : host))
    expect(getPaletteHostBadge('local', hosts)).toBeNull()
    expect(getPaletteHostBadge('runtime:env-1', hosts, true)).toEqual({
      hostId: 'runtime:env-1',
      label: 'env-1'
    })
  }
)
