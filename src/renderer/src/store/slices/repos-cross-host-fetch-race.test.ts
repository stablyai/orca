import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { createCompatibleRuntimeStatusResponseIfNeeded } from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { createTestStore } from './store-test-helpers'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

let resolveLocalRepos: (repos: Repo[]) => void

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  const localRepos = new Promise<Repo[]>((resolve) => {
    resolveLocalRepos = resolve
  })
  vi.stubGlobal('window', {
    api: {
      repos: { list: () => localRepos },
      projects: { list: async () => [], listHostSetups: async () => [] },
      projectGroups: { list: async () => [] },
      folderWorkspaces: { list: async () => [] },
      runtimeEnvironments: {
        call: async (request: { id: string; method: string }) => {
          const compatibility = createCompatibleRuntimeStatusResponseIfNeeded(request)
          if (compatibility) {
            return compatibility
          }
          return {
            id: request.id,
            ok: true,
            result: request.method === 'repo.list' ? { repos: [remoteRepo] } : {},
            _meta: { runtimeId: 'runtime-remote' }
          }
        }
      }
    }
  })
})

describe('repos slice cross-host fetch race', () => {
  it('keeps a runtime catalog that resolves before an older local catalog', async () => {
    const store = createTestStore()

    const localLoad = store.getState().fetchRepos()
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')
    expect(store.getState().repos).toEqual([{ ...remoteRepo, executionHostId: 'runtime:env-1' }])

    resolveLocalRepos([localRepo])
    await localLoad

    expect(store.getState().repos).toEqual([
      { ...remoteRepo, executionHostId: 'runtime:env-1' },
      { ...localRepo, executionHostId: 'local' }
    ])
  })
})
