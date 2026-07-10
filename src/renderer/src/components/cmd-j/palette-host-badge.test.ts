import { describe, expect, it } from 'vitest'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import { getPaletteHostBadge } from './palette-host-badge'
import { buildSidebarHostOptions } from '../sidebar/sidebar-host-options'

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

// Why: a connected SSH state makes the target a live remote, which is what the
// palette badge now requires before disambiguating rows with a host label.
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

    expect(getPaletteHostBadge({ connectionId: null }, hosts)).toBeNull()
  })

  it('returns null when the only non-local host is configured but disconnected', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    // No connection state -> the SSH host is 'disconnected', so there's nothing
    // live to disambiguate from and rows stay badge-free.
    expect(getPaletteHostBadge({ connectionId: null }, hosts)).toBeNull()
  })

  it('badges the local host when a connected remote host exists', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      sshConnectionStates: connectedSshStates('ssh-1'),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge({ connectionId: null }, hosts)).toEqual({
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

    expect(getPaletteHostBadge({ connectionId: 'ssh-1' }, hosts)).toEqual({
      hostId: 'ssh:ssh-1',
      label: 'Builder'
    })
  })

  it('badges runtime-hosted repos when the runtime is live', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ executionHostId: 'runtime:env-1' }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: 'env-2' },
      // A live status makes the runtime 'available'; without it the host reads
      // 'disconnected' and the badge is suppressed (covered below).
      runtimeStatusByEnvironmentId: new Map([
        [
          'env-1',
          {
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

    expect(getPaletteHostBadge({ executionHostId: 'runtime:env-1' }, hosts)).toEqual({
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

    expect(getPaletteHostBadge({ connectionId: null }, hosts)).toBeNull()
  })

  it('maps repos with no executionHostId/connectionId to local', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      sshConnectionStates: connectedSshStates('ssh-1'),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge({}, hosts)).toEqual({
      hostId: 'local',
      label: LOCAL_HOST_LABEL
    })
  })

  it('returns null when the repo is missing', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      sshConnectionStates: connectedSshStates('ssh-1'),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge(null, hosts)).toBeNull()
  })
})
