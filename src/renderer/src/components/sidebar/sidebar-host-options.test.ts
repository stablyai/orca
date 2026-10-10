import { describe, expect, it } from 'vitest'
import { getExecutionHostLabel } from '../../../../shared/execution-host'
import {
  buildSidebarHostOptions,
  buildSidebarHostScopeOptions,
  getSidebarHostVisibilityLabel,
  getSidebarHostHealthDotClass,
  getSidebarHostHealthLabel,
  shouldShowHostScopeControls,
  toggleVisibleHostRow,
  type SidebarHostOption
} from './sidebar-host-options'
import { filterFolderWorkspacesForVisibleHosts } from './worktree-list/listing/host-filtering'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { SshConnectionState } from '../../../../shared/ssh-types'

const LOCAL_HOST_LABEL = getExecutionHostLabel('local')

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
        label: LOCAL_HOST_LABEL,
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
    // A first probe still in progress is not evidence of disconnection.
    expect(hosts.find((host) => host.id === 'runtime:runtime-1')).toMatchObject({
      detail: 'Orca server',
      health: 'connecting'
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
            checkedAt: 0,
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
      { id: 'all', label: 'All hosts', detail: `${LOCAL_HOST_LABEL}, Builder`, health: 'mixed' },
      { id: 'local', label: LOCAL_HOST_LABEL, health: 'local' },
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

  it('colors the host status dot by health', () => {
    expect(getSidebarHostHealthDotClass('local')).toBe('bg-status-success')
    expect(getSidebarHostHealthDotClass('available')).toBe('bg-status-success')
    expect(getSidebarHostHealthDotClass('connecting')).toBe('bg-status-warning')
    expect(getSidebarHostHealthDotClass('disconnected')).toBe('bg-muted-foreground/40')
    expect(getSidebarHostHealthDotClass('blocked')).toBe('bg-destructive')
    expect(getSidebarHostHealthDotClass('error')).toBe('bg-destructive')
  })

  it('names a host scope saved under either merged id after the merged host', () => {
    const hosts = mergedHosts()

    expect(hosts.map((host) => host.id)).toEqual([
      'local',
      'runtime:omarchy-server',
      'ssh:omarchy-target'
    ])
    expect(getSidebarHostVisibilityLabel(['ssh:omarchy-target'], hosts)).toBe('Omarchy')
    expect(getSidebarHostVisibilityLabel(['runtime:omarchy-server'], hosts)).toBe('Omarchy')
    expect(buildSidebarHostScopeOptions(hosts).map((option) => option.id)).toEqual([
      'all',
      'local',
      'runtime:omarchy-server'
    ])
  })

  it('keeps folder-only workspaces of the merged-away id when the merged host is chosen', () => {
    const hosts = mergedHosts({ kind: 'relay', reason: 'source_changed' })
    const shown = hosts.find((host) => host.id === 'ssh:omarchy-target')
    expect(shown?.aliasHostIds).toEqual(['runtime:omarchy-server'])

    const visible = toggleVisibleHostRow(hosts, null, shown!)
    const group = projectGroup('runtime:omarchy-server')

    expect(new Set(visible)).toEqual(new Set(['ssh:omarchy-target', 'runtime:omarchy-server']))
    expect(
      filterFolderWorkspacesForVisibleHosts(
        [folderWorkspace(group.id)],
        [group],
        new Set(visible),
        'local'
      )
    ).toHaveLength(1)
    // Unchecking the row removes both ids, and all rows checked collapses to every host.
    expect(toggleVisibleHostRow(hosts, ['local', ...visible!], shown!)).toEqual(['local'])
    expect(toggleVisibleHostRow(hosts, ['local'], shown!)).toBeNull()
  })
})

function mergedHosts(managedServer?: SshConnectionState['managedServer']): SidebarHostOption[] {
  return buildSidebarHostOptions({
    repos: [],
    sshTargetLabels: new Map([['omarchy-target', 'Omarchy']]),
    sshConnectionStates: managedServer
      ? new Map([
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
      : undefined,
    settings: null,
    runtimeEnvironments: [
      {
        id: 'omarchy-server',
        name: 'Omarchy',
        orcadDeployment: {
          sshTargetId: 'omarchy-target',
          sshTargetGeneration: 1,
          localPort: 7001,
          remotePort: 7002
        }
      }
    ]
  })
}

function projectGroup(executionHostId: string): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Notes',
    parentPath: null,
    executionHostId,
    parentGroupId: null,
    createdFrom: 'manual',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function folderWorkspace(projectGroupId: string): FolderWorkspace {
  return {
    id: 'folder-1',
    projectGroupId,
    name: 'notes',
    folderPath: '/notes',
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 1,
    createdAt: 1,
    updatedAt: 1
  }
}
