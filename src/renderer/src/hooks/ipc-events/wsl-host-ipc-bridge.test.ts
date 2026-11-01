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

  it('boots only the focused host at launch when two hosts have saved tabs', () => {
    const store = backgroundWslTabs()
    const debianWorktree = 'debian-repo::/home/me/api'
    store.setState({
      runtimeEnvironments: [
        ...store.getState().runtimeEnvironments,
        {
          ...store.getState().runtimeEnvironments[0],
          id: 'wsl:debian',
          name: 'Debian (WSL)',
          orcadDeployment: { kind: 'wsl', distro: 'Debian', localPort: 42001, remotePort: 6768 }
        }
      ],
      repos: [
        ...store.getState().repos,
        {
          id: 'debian-repo',
          path: '/home/me/api',
          displayName: 'api',
          badgeColor: '',
          addedAt: 0,
          executionHostId: toRuntimeExecutionHostId('wsl:debian')
        }
      ],
      activeWorktreeId: debianWorktree,
      tabsByWorktree: {
        ...store.getState().tabsByWorktree,
        [debianWorktree]: [makeTab({ id: 'tab-2', worktreeId: debianWorktree })]
      }
    })
    expect(selectWslHostsWithVisibleWork(store.getState())).toEqual(['wsl:debian'])
  })

  it('ignores a background workspace that only has saved tabs, so launch boots the focused host only', () => {
    const store = backgroundWslTabs()
    expect(selectWslHostsWithVisibleWork(store.getState())).toEqual([])
  })

  it('keeps a background workspace focused earlier this session while its tabs stay open', () => {
    const store = backgroundWslTabs()
    expect(selectWslHostsWithVisibleWork(store.getState(), new Set([WSL_WORKTREE]))).toEqual([
      WSL_ENV
    ])
    store.setState({ tabsByWorktree: {} })
    expect(selectWslHostsWithVisibleWork(store.getState(), new Set([WSL_WORKTREE]))).toEqual([])
  })
})

const WSL_WORKTREE = 'wsl-repo::/home/me/app'

function backgroundWslTabs() {
  return storeWith({
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
    tabsByWorktree: { [WSL_WORKTREE]: [makeTab({ id: 'tab-1', worktreeId: WSL_WORKTREE })] }
  })
}
