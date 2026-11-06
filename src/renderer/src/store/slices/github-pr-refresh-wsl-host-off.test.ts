import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { Repo } from '../../../../shared/repo-types'
import type { AppState } from '../types'
import {
  createTestStore,
  makePR,
  makePRRefreshWorktree,
  resetRemoteRuntimeMocks,
  runtimeEnvironmentCall
} from './github-slice-test-harness'

const WSL_ENV: AppState['runtimeEnvironments'][number] = {
  id: 'env-1',
  name: 'Ubuntu (WSL)',
  createdAt: 0,
  updatedAt: 0,
  lastUsedAt: null,
  runtimeId: null,
  preferredEndpointId: 'ws',
  endpoints: [],
  orcadDeployment: { kind: 'wsl', distro: 'Ubuntu', localPort: 42000, remotePort: 6768 }
}

const REPO: Repo = {
  id: 'repo-wsl',
  path: '/home/me/app',
  displayName: 'app',
  badgeColor: 'blue',
  addedAt: 1,
  kind: 'git',
  executionHostId: 'runtime:env-1',
  gitRemoteIdentity: {
    canonicalKey: 'github.com/owner/repo',
    remoteName: 'origin',
    remoteUrl: 'https://github.com/owner/repo.git'
  }
}

function status(state: 'ready' | 'distro-stopped'): AppState['wslHostStatuses'] {
  return { 'env-1': { environmentId: 'env-1', distro: 'Ubuntu', state, detail: null } }
}

describe('PR refresh for a WSL host that is off (E9)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('keeps the last badge, records host-off, and never asks the host', async () => {
    runtimeEnvironmentCall.mockResolvedValueOnce({
      id: 'rpc-1',
      ok: true,
      result: makePR({ number: 31 }),
      _meta: { runtimeId: 'remote-runtime' }
    })
    const store = createTestStore()
    store.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: null },
      repos: [REPO],
      worktreesByRepo: {
        'repo-wsl': [
          makePRRefreshWorktree({ id: 'wt-wsl', repoId: 'repo-wsl', branch: 'feature/x' })
        ]
      },
      prCache: {},
      hostedReviewCache: {},
      sshConnectionStates: new Map(),
      runtimeEnvironments: [WSL_ENV],
      wslHostStatuses: status('ready')
    })
    store.getState().enqueueGitHubPRRefresh('wt-wsl', 'manual', 100)
    await vi.waitFor(() =>
      expect(
        Object.values(store.getState().prCache).some((entry) => entry.data?.number === 31)
      ).toBe(true)
    )

    store.setState({ wslHostStatuses: status('distro-stopped') })
    store.getState().enqueueGitHubPRRefresh('wt-wsl', 'manual', 100)

    await vi.waitFor(() =>
      expect(Object.values(store.getState().prRefreshStates)).toContainEqual(
        expect.objectContaining({ status: 'skipped', skippedReason: 'host-off' })
      )
    )
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(Object.values(store.getState().prCache).map((entry) => entry.data?.number)).toEqual([31])
  })
})
