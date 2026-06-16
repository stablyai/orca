import { describe, expect, it } from 'vitest'
import { getLocalExecutionHostLabel } from '../../../../shared/execution-host'
import {
  buildSidebarHostOptions,
  buildSidebarHostScopeOptions,
  getSidebarHostVisibilityLabel,
  getSidebarHostHealthLabel,
  shouldShowHostScopeControls
} from './sidebar-host-options'

describe('sidebar host options', () => {
  it('hides host controls for local-only workspaces', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: null }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(hosts).toEqual([
      {
        id: 'local',
        label: getLocalExecutionHostLabel(),
        detail: 'This computer',
        kind: 'local',
        health: 'local',
        presence: 'local'
      }
    ])
    expect(shouldShowHostScopeControls(hosts)).toBe(false)
  })

  it('includes SSH hosts from labels and repos', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-from-repo' }],
      sshTargetLabels: new Map([['ssh-saved', 'Saved SSH']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(hosts.map((host) => host.id)).toEqual(['local', 'ssh:ssh-saved', 'ssh:ssh-from-repo'])
    expect(hosts.map((host) => host.health)).toEqual(['local', 'disconnected', 'disconnected'])
    expect(hosts.find((host) => host.id === 'ssh:ssh-saved')?.presence).toBe('configured')
    expect(hosts.find((host) => host.id === 'ssh:ssh-from-repo')?.presence).toBe('project')
    expect(shouldShowHostScopeControls(hosts)).toBe(true)
  })

  it('includes SSH health in options', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      sshConnectionStates: new Map([
        [
          'ssh-1',
          {
            targetId: 'ssh-1',
            status: 'connected',
            error: null,
            reconnectAttempt: 0
          }
        ]
      ]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(hosts.find((host) => host.id === 'ssh:ssh-1')).toMatchObject({
      label: 'Builder',
      health: 'available'
    })
  })

  it('includes the focused runtime compatibility host', () => {
    const hosts = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: 'runtime-1' }
    })

    expect(hosts.map((host) => host.id)).toEqual(['local', 'runtime:runtime-1'])
    // Without live status the focused runtime has no proof of reachability, so it
    // reads 'disconnected' rather than defaulting to 'available'/"Connected".
    expect(hosts.find((host) => host.id === 'runtime:runtime-1')).toMatchObject({
      detail: 'Orca server',
      health: 'disconnected'
    })
  })

  it('uses saved runtime environment names for runtime host labels', () => {
    const hosts = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: '03ef704c-b180-4b10-998d-e28fbd5de9a3' },
      runtimeEnvironments: [
        {
          id: '03ef704c-b180-4b10-998d-e28fbd5de9a3',
          name: 'dev box'
        }
      ]
    })

    expect(hosts.find((host) => host.id.startsWith('runtime:'))).toMatchObject({
      label: 'dev box',
      detail: 'Orca server'
    })
  })

  it('marks a runtime host blocked when its live status fails compat', () => {
    const hosts = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      // Why: protocol 0 is below the minimum compatible server version, so the
      // registry must surface a 'server-too-old' blocked verdict + health when
      // the live status map is passed.
      runtimeStatusByEnvironmentId: new Map([
        [
          'runtime-1',
          {
            status: {
              runtimeId: 'rt',
              rendererGraphEpoch: 0,
              graphStatus: 'ready',
              authoritativeWindowId: null,
              liveTabCount: 0,
              liveLeafCount: 0,
              runtimeProtocolVersion: 0,
              minCompatibleRuntimeClientVersion: 0
            }
          }
        ]
      ])
    })

    const runtimeHost = hosts.find((host) => host.id === 'runtime:runtime-1')
    expect(runtimeHost?.health).toBe('blocked')
    expect(runtimeHost?.compatibility).toMatchObject({
      kind: 'blocked',
      reason: 'server-too-old'
    })
  })

  it('leaves a runtime host available when its live status is compatible', () => {
    const hosts = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: 'runtime-1' },
      runtimeStatusByEnvironmentId: new Map([
        [
          'runtime-1',
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

    const runtimeHost = hosts.find((host) => host.id === 'runtime:runtime-1')
    expect(runtimeHost?.health).toBe('available')
    expect(runtimeHost?.compatibility?.kind).toBe('ok')
  })

  it('builds all-host plus focused-host scope options', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(buildSidebarHostScopeOptions(hosts)).toMatchObject([
      {
        id: 'all',
        label: 'All hosts',
        detail: `${getLocalExecutionHostLabel()}, Builder`,
        health: 'mixed'
      },
      { id: 'local', label: getLocalExecutionHostLabel(), health: 'local' },
      { id: 'ssh:ssh-1', label: 'Builder', health: 'disconnected' }
    ])
  })

  it('labels visible host selections for the workspace options menu', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getSidebarHostVisibilityLabel(null, hosts)).toBe('All hosts')
    expect(getSidebarHostVisibilityLabel(['ssh:ssh-1'], hosts)).toBe('Builder')
    expect(getSidebarHostVisibilityLabel(['local', 'ssh:ssh-1'], hosts)).toBe('All hosts')
  })

  it('carries host kind so the header menu can pick lifecycle actions', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: 'runtime-1' }
    })

    expect(hosts.find((host) => host.id === 'local')?.kind).toBe('local')
    expect(hosts.find((host) => host.id === 'ssh:ssh-1')?.kind).toBe('ssh')
    expect(hosts.find((host) => host.id === 'runtime:runtime-1')?.kind).toBe('runtime')
  })

  it('labels host health for compact sidebar UI', () => {
    expect(getSidebarHostHealthLabel('available')).toBe('Connected')
    expect(getSidebarHostHealthLabel('connecting')).toBe('Connecting')
    expect(getSidebarHostHealthLabel('blocked')).toBe('Update needed')
    expect(getSidebarHostHealthLabel('error')).toBe('Needs attention')
  })
})
