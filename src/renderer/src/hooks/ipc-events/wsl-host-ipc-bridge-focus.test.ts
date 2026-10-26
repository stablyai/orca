import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { toRuntimeExecutionHostId } from '../../../../shared/execution-host'
import { makeTab, seedStore, TEST_REPO } from '../../store/slices/store-test-helpers'

vi.mock('../../store', async () => {
  const { createTestStore } = await import('../../store/slices/store-test-helpers')
  return { useAppStore: createTestStore() }
})

const { useAppStore } = await import('../../store')
const { registerWslHostIpcBridge } = await import('./wsl-host-ipc-bridge')

const WSL_ENV = 'wsl:ubuntu'
const WSL_WORKTREE = 'wsl-repo::/home/me/app'
const LOCAL_WORKTREE = `${TEST_REPO.id}::/repo1`

const api = {
  onStatusChanged: vi.fn(() => () => {}),
  getStatuses: vi.fn(async () => []),
  setVisibleWork: vi.fn(async (_args: { environmentIds: string[] }) => {}),
  focusHost: vi.fn(async (_args: { environmentId: string | null }) => {})
}

function seed(experimentalWslHosts: boolean, activeWorktreeId: string): void {
  seedStore(useAppStore, {
    settings: { ...getDefaultSettings('/tmp'), experimentalWslHosts },
    activeWorktreeId,
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
      }
    ],
    tabsByWorktree: { [WSL_WORKTREE]: [makeTab({ id: 'tab-1', worktreeId: WSL_WORKTREE })] }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  Object.assign(globalThis, { window: { api: { runtimeEnvironments: { wslHosts: api } } } })
})

describe('WSL host focus entries (E9)', () => {
  it('reports a focus entry each time the user switches to the host, even with work unchanged', () => {
    seed(true, WSL_WORKTREE)
    const unsubs: (() => void)[] = []
    registerWslHostIpcBridge(unsubs)
    // Launch restored the focused workspace: one focus entry, which may boot it.
    expect(api.focusHost).toHaveBeenCalledExactlyOnceWith({ environmentId: WSL_ENV })

    // Away and back: the visible set never changes (its tabs stay), but the return is an act.
    useAppStore.setState({ activeWorktreeId: LOCAL_WORKTREE })
    useAppStore.setState({ activeWorktreeId: WSL_WORKTREE })
    expect(api.focusHost.mock.calls).toEqual([
      [{ environmentId: WSL_ENV }],
      // Off WSL: the next launch has no host to start early.
      [{ environmentId: null }],
      [{ environmentId: WSL_ENV }]
    ])
    expect(api.setVisibleWork).toHaveBeenCalledTimes(1)
    unsubs.forEach((unsub) => unsub())
  })

  it('records no focus while WSL hosts are off, and reports the focused host when turned on', () => {
    seed(false, WSL_WORKTREE)
    const unsubs: (() => void)[] = []
    registerWslHostIpcBridge(unsubs)
    useAppStore.setState({ activeWorktreeId: LOCAL_WORKTREE })
    useAppStore.setState({ activeWorktreeId: WSL_WORKTREE })
    expect(api.focusHost).not.toHaveBeenCalled()
    expect(api.setVisibleWork).not.toHaveBeenCalled()

    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), experimentalWslHosts: true }
    })
    expect(api.focusHost).toHaveBeenCalledExactlyOnceWith({ environmentId: WSL_ENV })
    unsubs.forEach((unsub) => unsub())
  })
})
