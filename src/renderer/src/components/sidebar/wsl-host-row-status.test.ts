import { describe, expect, it } from 'vitest'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { buildSidebarHostOptions } from './sidebar-host-options'
import { canConnectAddRepoHost, canSelectAddRepoHost } from './add-repo-host-availability'
import { getWslHostRowDetail, getWslHostRowHealth } from './wsl-host-row-status'

function status(state: WslHostStatus['state']): WslHostStatus {
  return { environmentId: 'wsl:ubuntu', distro: 'Ubuntu', state, detail: null }
}

describe('WSL host row status', () => {
  it('lets the liveness verdict decide health until the server answers', () => {
    expect(getWslHostRowHealth('available', status('ready'))).toBe('available')
    expect(getWslHostRowHealth('disconnected', undefined)).toBe('disconnected')
    expect(getWslHostRowHealth('available', status('distro-stopped'))).toBe('disconnected')
    expect(getWslHostRowHealth('disconnected', status('connecting'))).toBe('connecting')
    expect(getWslHostRowHealth('disconnected', status('reconnecting'))).toBe('connecting')
    expect(getWslHostRowHealth('available', status('unverifiable'))).toBe('error')
    expect(getWslHostRowHealth('disconnected', status('failed'))).toBe('error')
  })

  it('names the row a WSL distro and adds the state when it is not plain', () => {
    expect(getWslHostRowDetail(status('ready'))).toBe('WSL distro')
    expect(getWslHostRowDetail(status('distro-stopped'))).toBe('WSL distro · Distro stopped')
  })

  it('marks the WSL host’s own row, which connects like an SSH host while stopped', () => {
    const [, wsl] = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null },
      runtimeEnvironments: [
        {
          id: 'wsl:ubuntu',
          name: 'Ubuntu (WSL)',
          orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
        }
      ],
      wslHostStatuses: { 'wsl:ubuntu': status('distro-stopped') }
    })
    expect(wsl).toMatchObject({
      id: 'runtime:wsl%3Aubuntu',
      label: 'Ubuntu (WSL)',
      detail: 'WSL distro · Distro stopped',
      health: 'disconnected',
      wslDistro: 'Ubuntu'
    })
    expect(canSelectAddRepoHost(wsl)).toBe(false)
    expect(canConnectAddRepoHost(wsl)).toBe(true)
  })

  it('keeps a WSL host’s row while the experiment is off, turned off and never connectable', () => {
    const [, wsl] = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null },
      runtimeEnvironments: [
        {
          id: 'wsl:ubuntu',
          name: 'Ubuntu (WSL)',
          orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
        }
      ],
      wslHostStatuses: { 'wsl:ubuntu': status('ready') },
      wslHostsEnabled: false
    })
    expect(wsl).toMatchObject({
      label: 'Ubuntu (WSL)',
      detail: 'Turned off in Settings → Experimental',
      health: 'disconnected',
      wslUnavailable: 'turned-off'
    })
    expect(canSelectAddRepoHost(wsl)).toBe(false)
    expect(canConnectAddRepoHost(wsl)).toBe(false)
  })

  it('marks a WSL host this build cannot run, ahead of the turned-off state', () => {
    const [, wsl] = buildSidebarHostOptions({
      repos: [],
      sshTargetLabels: new Map(),
      settings: { activeRuntimeEnvironmentId: null },
      runtimeEnvironments: [
        {
          id: 'wsl:ubuntu',
          name: 'Ubuntu (WSL)',
          orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
        }
      ],
      wslHostsEnabled: false,
      wslHostServerFilesMissing: true
    })
    expect(wsl).toMatchObject({
      detail: 'This build can’t run WSL hosts',
      health: 'disconnected',
      wslUnavailable: 'server-files-missing'
    })
    expect(canConnectAddRepoHost(wsl)).toBe(false)
  })
})
