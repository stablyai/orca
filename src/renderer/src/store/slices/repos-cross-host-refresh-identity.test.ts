import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

// One project cloned on the local Mac and on a remote Orca server under distinct repo ids —
// the shape the compat merge exists to serve, and the only shape whose sourceRepoIds are
// assembled from two hosts.
const SHARED_PROJECT_ID = 'github:stablyai/orca'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local/orca',
  displayName: 'orca',
  badgeColor: '#22c55e',
  upstream: { owner: 'stablyai', repo: 'orca' },
  addedAt: 1_700_000_000_000
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/srv/orca',
  displayName: 'orca',
  badgeColor: '#737373',
  upstream: { owner: 'stablyai', repo: 'orca' },
  addedAt: 1_700_000_001_000
}

const localProject: Project = {
  id: SHARED_PROJECT_ID,
  displayName: 'orca',
  badgeColor: '#22c55e',
  sourceRepoIds: ['local-repo'],
  createdAt: 1,
  updatedAt: 1
}

const remoteProject: Project = {
  ...localProject,
  badgeColor: '#737373',
  sourceRepoIds: ['remote-repo'],
  createdAt: 2,
  updatedAt: 2
}

function setup(repoId: string, path: string): ProjectHostSetup {
  return {
    id: `${repoId}-setup`,
    projectId: SHARED_PROJECT_ID,
    hostId: 'local',
    repoId,
    path,
    displayName: 'orca',
    setupState: 'ready',
    setupMethod: 'imported-existing-folder',
    createdAt: 1,
    updatedAt: 1
  }
}

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

// Why: catalogs arrive over IPC, so every fetch must hand back freshly allocated rows —
// otherwise identity would match by accident and prove nothing.
function clone<T>(value: T): T {
  return structuredClone(value)
}

function runtimeResult(method: string): unknown {
  if (method === 'repo.list') {
    return { repos: [clone(remoteRepo)] }
  }
  if (method === 'project.list') {
    return { projects: [clone(remoteProject)] }
  }
  if (method === 'projectHostSetup.list') {
    return { setups: [clone(setup('remote-repo', '/srv/orca'))] }
  }
  return {}
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  runtimeEnvironmentsList.mockReset()
  runtimeEnvironmentTransportCall.mockReset()

  reposList.mockImplementation(async () => [clone(localRepo)])
  projectsList.mockImplementation(async () => [clone(localProject)])
  listHostSetups.mockImplementation(async () => [clone(setup('local-repo', '/local/orca'))])
  runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1', name: 'awin' }])
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    const compatible = createCompatibleRuntimeStatusResponseIfNeeded(args)
    if (compatible) {
      return compatible
    }
    return {
      id: `rpc-${args.method}`,
      ok: true,
      result: runtimeResult(args.method),
      _meta: { runtimeId: 'runtime-remote' }
    }
  })

  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups },
      projectGroups: { list: vi.fn().mockResolvedValue([]) },
      folderWorkspaces: { list: vi.fn().mockResolvedValue([]) },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      }
    },
    dispatchEvent: vi.fn()
  })
})

function sharedProject(store: ReturnType<typeof createTestStore>): Project | undefined {
  return store.getState().projects.find((project) => project.id === SHARED_PROJECT_ID)
}

describe('cross-host project refresh identity', () => {
  it('keeps sourceRepoIds ordered the same whichever host refreshed', async () => {
    const store = createTestStore()
    // Why: with no active env, `fetchRepos` targets local, so the two calls below really do
    // alternate hosts.
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })
    await store.getState().fetchReposForAllHosts()
    const afterAllHosts = sharedProject(store)?.sourceRepoIds
    expect(afterAllHosts).toHaveLength(2)

    await store.getState().fetchRepos()
    const afterLocal = sharedProject(store)?.sourceRepoIds

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')
    const afterRuntime = sharedProject(store)?.sourceRepoIds

    expect(afterLocal).toEqual(afterAllHosts)
    expect(afterRuntime).toEqual(afterAllHosts)
  })

  it('reuses the cross-host project row across alternating single-host refreshes', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: null } as never })
    await store.getState().fetchReposForAllHosts()
    // Why: the first local pass lands before the runtime catalog exists, so settle onto the
    // two-host fixed point before measuring identity.
    await store.getState().fetchRepos()
    const settled = sharedProject(store)

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')
    expect(sharedProject(store)).toBe(settled)

    await store.getState().fetchRepos()
    expect(sharedProject(store)).toBe(settled)
  })

  it('reuses the cross-host project row across a no-op all-hosts refresh', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })
    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchReposForAllHosts()
    const settled = sharedProject(store)

    await store.getState().fetchReposForAllHosts()

    expect(sharedProject(store)).toBe(settled)
  })
})
