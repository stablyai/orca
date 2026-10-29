import { describe, expect, it } from 'vitest'
import type { AppState } from '../types'
import type { WslHostStatus } from '../../../../shared/wsl-host-types'
import { isWslHostOffForForge } from './wsl-host-off-forge'

function environment(id: string, wsl: boolean): AppState['runtimeEnvironments'][number] {
  return {
    id,
    name: id,
    createdAt: 0,
    updatedAt: 0,
    lastUsedAt: null,
    runtimeId: null,
    preferredEndpointId: 'ws',
    endpoints: [],
    ...(wsl
      ? { orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 } }
      : {})
  }
}

function status(state: WslHostStatus['state']): WslHostStatus {
  return { environmentId: 'wsl:ubuntu', distro: 'Ubuntu', state, detail: null }
}

describe('isWslHostOffForForge', () => {
  const runtimeEnvironments = [environment('wsl:ubuntu', true), environment('box', false)]

  it.each(['distro-stopped', 'closed'] as const)('skips a WSL host that is %s', (state) => {
    expect(
      isWslHostOffForForge(
        { runtimeEnvironments, wslHostStatuses: { 'wsl:ubuntu': status(state) } },
        'wsl:ubuntu'
      )
    ).toBe(true)
  })

  it.each(['connecting', 'reconnecting', 'unverifiable', 'failed'] as const)(
    'lets a %s WSL host try, as any other call would',
    (state) => {
      expect(
        isWslHostOffForForge(
          { runtimeEnvironments, wslHostStatuses: { 'wsl:ubuntu': status(state) } },
          'wsl:ubuntu'
        )
      ).toBe(false)
    }
  )

  it('lets a WSL host with no status yet try', () => {
    expect(isWslHostOffForForge({ runtimeEnvironments, wslHostStatuses: {} }, 'wsl:ubuntu')).toBe(
      false
    )
  })

  it('lets a ready WSL host and any other paired host refresh as before', () => {
    expect(
      isWslHostOffForForge(
        { runtimeEnvironments, wslHostStatuses: { 'wsl:ubuntu': status('ready') } },
        'wsl:ubuntu'
      )
    ).toBe(false)
    expect(isWslHostOffForForge({ runtimeEnvironments, wslHostStatuses: {} }, 'box')).toBe(false)
  })
})
