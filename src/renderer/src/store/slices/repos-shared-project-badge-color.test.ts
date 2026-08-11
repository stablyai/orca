import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

// Mirrors the real report: one project name ("orca") set up on the local Mac and on a
// remote Orca server, where only the local repo row carries the user's chosen color.
const SHARED_PROJECT_ID = 'github:stablyai/orca'
const LOCAL_GREEN = '#22c55e'
const REMOTE_NEUTRAL = '#737373'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local/orca',
  displayName: 'orca',
  badgeColor: LOCAL_GREEN,
  upstream: { owner: 'stablyai', repo: 'orca' },
  addedAt: 1
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/srv/orca',
  displayName: 'orca',
  badgeColor: REMOTE_NEUTRAL,
  upstream: { owner: 'stablyai', repo: 'orca' },
  addedAt: 1
}

const localProject: Project = {
  id: SHARED_PROJECT_ID,
  displayName: 'orca',
  badgeColor: LOCAL_GREEN,
  sourceRepoIds: ['local-repo'],
  createdAt: 1,
  updatedAt: 1
}

const remoteProject: Project = {
  id: SHARED_PROJECT_ID,
  displayName: 'orca',
  badgeColor: REMOTE_NEUTRAL,
  sourceRepoIds: ['remote-repo'],
  createdAt: 2,
  updatedAt: 2
}

function setup(projectId: string, repoId: string, path: string): ProjectHostSetup {
  return {
    id: `${repoId}-setup`,
    projectId,
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
const reposUpdate = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

function runtimeResult(method: string): unknown {
  if (method === 'repo.list') {
    return { repos: [remoteRepo] }
  }
  if (method === 'project.list') {
    return { projects: [remoteProject] }
  }
  if (method === 'projectHostSetup.list') {
    return { setups: [setup(SHARED_PROJECT_ID, 'remote-repo', '/srv/orca')] }
  }
  return {}
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  reposUpdate.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  runtimeEnvironmentsList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()

  reposList.mockResolvedValue([localRepo])
  reposUpdate.mockImplementation(({ updates }: { updates: Partial<Repo> }) => ({
    ...localRepo,
    ...updates
  }))
  projectsList.mockResolvedValue([localProject])
  listHostSetups.mockResolvedValue([setup(SHARED_PROJECT_ID, 'local-repo', '/local/orca')])
  runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1', name: 'awin' }])
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => ({
    id: `rpc-${args.method}`,
    ok: true,
    result: runtimeResult(args.method),
    _meta: { runtimeId: 'runtime-remote' }
  }))
  runtimeEnvironmentTransportCall.mockImplementation(
    (args: RuntimeEnvironmentCallRequest) =>
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  )

  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList, update: reposUpdate },
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

function badgeColor(store: ReturnType<typeof createTestStore>): string | undefined {
  return store.getState().projects.find((project) => project.id === SHARED_PROJECT_ID)?.badgeColor
}

describe('shared project badge color across hosts', () => {
  it('keeps the local color when a remote host shares the project name', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    expect(badgeColor(store)).toBe(LOCAL_GREEN)
  })

  it('keeps the local color when a runtime-only refresh lands after startup', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expect(badgeColor(store)).toBe(LOCAL_GREEN)
  })

  it('reflects a recolor of the local repo even while the remote host stays connected', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()
    const recolored = '#ec4899'
    await store.getState().updateRepo('local-repo', { badgeColor: recolored }, { hostId: 'local' })

    expect(store.getState().repos.find((repo) => repo.id === 'local-repo')?.badgeColor).toBe(
      recolored
    )
    expect(badgeColor(store)).toBe(recolored)
  })

  it('leaves a remote-only project showing its own host color', async () => {
    reposList.mockResolvedValue([])
    projectsList.mockResolvedValue([])
    listHostSetups.mockResolvedValue([])
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    expect(badgeColor(store)).toBe(REMOTE_NEUTRAL)
  })
})
