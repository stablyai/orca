import { describe, expect, it } from 'vitest'
import { getPaletteHostBadge } from './palette-host-badge'
import { buildSidebarHostOptions } from '../sidebar/sidebar-host-options'

describe('getPaletteHostBadge', () => {
  it('returns null for single-host (local-only) workspaces', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: null }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge({ connectionId: null }, hosts)).toBeNull()
  })

  it('badges the local host when multiple hosts exist', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge({ connectionId: null }, hosts)).toEqual({
      hostId: 'local',
      label: 'Local Mac'
    })
  })

  it('uses the ssh target label for ssh repos', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge({ connectionId: 'ssh-1' }, hosts)).toEqual({
      hostId: 'ssh:ssh-1',
      label: 'Builder'
    })
  })

  it('badges runtime-hosted repos', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ executionHostId: 'runtime:env-1' }],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: 'env-2' }
    })

    expect(getPaletteHostBadge({ executionHostId: 'runtime:env-1' }, hosts)).toEqual({
      hostId: 'runtime:env-1',
      label: 'env-1'
    })
  })

  it('maps repos with no executionHostId/connectionId to local', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge({}, hosts)).toEqual({
      hostId: 'local',
      label: 'Local Mac'
    })
  })

  it('returns null when the repo is missing', () => {
    const hosts = buildSidebarHostOptions({
      repos: [{ connectionId: 'ssh-1' }],
      sshTargetLabels: new Map([['ssh-1', 'Builder']]),
      settings: { activeRuntimeEnvironmentId: null }
    })

    expect(getPaletteHostBadge(null, hosts)).toBeNull()
  })
})
