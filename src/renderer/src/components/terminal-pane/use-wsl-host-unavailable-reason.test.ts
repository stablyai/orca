import { describe, expect, it } from 'vitest'
import {
  createTestStore,
  runtimeOwnedRepoState,
  seedStore
} from '../../store/slices/store-test-helpers'
import { getDefaultSettings } from '../../../../shared/constants'
import { selectWslHostUnavailableReason } from './use-wsl-host-unavailable-reason'

const WORKTREE = 'wsl-repo::/home/me/app'

function stateWith(options: { enabled: boolean; serverFiles?: 'present' | 'missing' }) {
  const store = createTestStore()
  seedStore(store, {
    ...runtimeOwnedRepoState('wsl:ubuntu', 'wsl-repo', '/home/me/app'),
    runtimeEnvironments: [
      {
        id: 'wsl:ubuntu',
        name: 'Ubuntu (WSL)',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: null,
        preferredEndpointId: 'ws',
        endpoints: [],
        orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
      }
    ],
    wslHostServerFiles: options.serverFiles ?? 'present'
  })
  store.setState({
    settings: { ...getDefaultSettings('/home/me'), experimentalWslHosts: options.enabled }
  })
  return store.getState()
}

describe('selectWslHostUnavailableReason', () => {
  it('says a WSL host’s terminal is turned off rather than reconnecting', () => {
    expect(selectWslHostUnavailableReason(stateWith({ enabled: false }), WORKTREE)).toBe(
      'turned-off'
    )
  })

  it('prefers the missing server files, and is quiet when the host can run', () => {
    expect(
      selectWslHostUnavailableReason(stateWith({ enabled: true, serverFiles: 'missing' }), WORKTREE)
    ).toBe('server-files-missing')
    expect(selectWslHostUnavailableReason(stateWith({ enabled: true }), WORKTREE)).toBeNull()
  })

  it('leaves other hosts’ workspaces alone', () => {
    expect(
      selectWslHostUnavailableReason(stateWith({ enabled: false }), 'repo1::/repo1')
    ).toBeNull()
  })

  it('is quiet when no WSL host exists, even for a workspace on another runtime', () => {
    const store = createTestStore()
    seedStore(store, {
      ...runtimeOwnedRepoState('paired', 'remote-repo', '/srv/app'),
      runtimeEnvironments: [
        {
          id: 'paired',
          name: 'Paired server',
          createdAt: 0,
          updatedAt: 0,
          lastUsedAt: null,
          runtimeId: null,
          preferredEndpointId: 'ws',
          endpoints: []
        }
      ]
    })
    store.setState({ settings: { ...getDefaultSettings('/home/me'), experimentalWslHosts: false } })
    expect(selectWslHostUnavailableReason(store.getState(), 'remote-repo::/srv/app')).toBeNull()
  })
})
