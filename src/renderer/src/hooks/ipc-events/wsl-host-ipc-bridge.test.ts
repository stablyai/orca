import { describe, expect, it } from 'vitest'
import {
  createTestStore,
  makeTab,
  runtimeOwnedRepoState,
  seedStore,
  TEST_REPO
} from '../../store/slices/store-test-helpers'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { selectWslHostsWithVisibleWork } from './wsl-host-ipc-bridge'

const WSL_ENV = 'wsl:ubuntu'

function storeWith(state: Parameters<typeof seedStore>[1]) {
  const store = createTestStore()
  seedStore(store, {
    ...runtimeOwnedRepoState(WSL_ENV, 'wsl-repo', '/home/me/app'),
    runtimeEnvironments: [
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
      },
      {
        id: 'ssh-box',
        name: 'Box',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: null,
        preferredEndpointId: 'ws',
        endpoints: []
      }
    ],
    ...state
  })
  return store
}

describe('selectWslHostsWithVisibleWork', () => {
  it('is empty when no project or terminal on a WSL host is open', () => {
    expect(selectWslHostsWithVisibleWork(storeWith({}).getState())).toEqual([])
  })

  it('names the WSL host of the active workspace, routed by the workspace’s own repo', () => {
    const store = storeWith({ activeWorktreeId: 'wsl-repo::/home/me/app' })
    expect(selectWslHostsWithVisibleWork(store.getState())).toEqual([WSL_ENV])
  })

  it('names the WSL host of a background workspace that has a terminal tab', () => {
    const worktreeId = 'wsl-repo::/home/me/app'
    const store = storeWith({
      activeWorktreeId: `${TEST_REPO.id}::/repo1`,
      repos: [
        { ...TEST_REPO, executionHostId: 'local' },
        {
          id: 'wsl-repo',
          path: '/home/me/app',
          displayName: 'app',
          badgeColor: '',
          addedAt: 0,
          executionHostId: toRuntimeExecutionHostId(WSL_ENV)
        }
      ],
      tabsByWorktree: { [worktreeId]: [makeTab({ id: 'tab-1', worktreeId })] }
    })
    expect(selectWslHostsWithVisibleWork(store.getState())).toEqual([WSL_ENV])
  })
})
