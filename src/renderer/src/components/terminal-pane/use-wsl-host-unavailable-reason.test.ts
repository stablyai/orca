import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { AppState } from '@/store/types'
import { selectWslHostUnavailableReason } from './use-wsl-host-unavailable-reason'
import { selectWslHostsServing } from '../sidebar/use-wsl-hosts-enabled'

const WSL_ENV = 'wsl:ubuntu'
const WORKTREE = 'wsl-repo::/home/me/app'

function state(experimentalWslHosts: boolean, withHost = true): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the selectors read only these fields.
  return {
    settings: { ...getDefaultSettings('/tmp'), experimentalWslHosts },
    wslHostServerFiles: 'present',
    folderWorkspaces: [],
    projectGroups: [],
    repos: [
      {
        id: 'wsl-repo',
        path: '/home/me/app',
        displayName: 'app',
        badgeColor: '',
        addedAt: 0,
        executionHostId: `runtime:${WSL_ENV}`
      }
    ],
    runtimeEnvironments: withHost
      ? [
          {
            id: WSL_ENV,
            name: 'Ubuntu (WSL)',
            createdAt: 0,
            updatedAt: 0,
            lastUsedAt: null,
            runtimeId: null,
            preferredEndpointId: 'ws',
            endpoints: [],
            orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
          }
        ]
      : []
  } as unknown as AppState
}

// Stage 1: the setting governs new work only; a moved project on a saved host stays reachable.
describe('a WSL host project with the WSL hosts setting off', () => {
  it('stays reachable: its panes and explorer show no "turned off" state', () => {
    expect(selectWslHostUnavailableReason(state(false), WORKTREE)).toBeNull()
    expect(selectWslHostsServing(state(false))).toBe(true)
  })

  it('serves nothing when there is no saved host and the setting is off', () => {
    expect(selectWslHostsServing(state(false, false))).toBe(false)
    expect(selectWslHostsServing(state(true, false))).toBe(true)
  })
})
