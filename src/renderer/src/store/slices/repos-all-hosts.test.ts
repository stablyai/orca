import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type {
  FolderWorkspace,
  Project,
  ProjectHostSetup,
  ProjectGroup,
  Repo
} from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { getSetupScriptPromptDismissalKey } from '../../lib/setup-script-prompt'

const localRepo: Repo = {
  id: 'local-repo',
  path: '/local',
  displayName: 'Local',
  badgeColor: '#000',
  addedAt: 1
}

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/srv/repo',
  displayName: 'Remote',
  badgeColor: '#000',
  addedAt: 1
}

const localProject: Project = {
  id: 'local-project',
  displayName: 'Local project',
  badgeColor: '#000',
  sourceRepoIds: ['local-repo'],
  createdAt: 1,
  updatedAt: 1
}

const localProjectHostSetup: ProjectHostSetup = {
  id: 'local-setup',
  projectId: 'local-project',
  hostId: 'local',
  repoId: 'local-repo',
  path: '/local',
  displayName: 'Local setup',
  setupState: 'setting-up',
  setupMethod: 'imported-existing-folder',
  createdAt: 1,
  updatedAt: 1
}

const localProjectGroup: ProjectGroup = {
  id: 'local-group',
  name: 'Local group',
  parentPath: '/local',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const remoteProjectGroup: ProjectGroup = {
  id: 'remote-group',
  name: 'Remote group',
  parentPath: '/srv',
  parentGroupId: null,
  createdFrom: 'manual',
  tabOrder: 0,
  isCollapsed: false,
  color: null,
  createdAt: 1,
  updatedAt: 1
}

const localFolderWorkspace: FolderWorkspace = {
  id: 'local-folder',
  projectGroupId: 'local-group',
  name: 'Local folder',
  folderPath: '/local',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const remoteFolderWorkspace: FolderWorkspace = {
  id: 'remote-folder',
  projectGroupId: 'remote-group',
  name: 'Remote folder',
  folderPath: '/srv',
  linkedTask: null,
  comment: '',
  isArchived: false,
  isUnread: false,
  isPinned: false,
  sortOrder: 0,
  lastActivityAt: 1,
  createdAt: 1,
  updatedAt: 1
}

const reposList = vi.fn()
const projectsList = vi.fn()
const listHostSetups = vi.fn()
const projectGroupsList = vi.fn()
const folderWorkspacesList = vi.fn()
const runtimeEnvironmentsList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const dispatchEventMock = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  projectsList.mockReset()
  listHostSetups.mockReset()
  projectGroupsList.mockReset()
  folderWorkspacesList.mockReset()
  runtimeEnvironmentsList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  dispatchEventMock.mockReset()

  reposList.mockResolvedValue([localRepo])
  projectsList.mockResolvedValue([localProject])
  listHostSetups.mockResolvedValue([localProjectHostSetup])
  projectGroupsList.mockResolvedValue([localProjectGroup])
  folderWorkspacesList.mockResolvedValue([localFolderWorkspace])
  runtimeEnvironmentsList.mockResolvedValue([{ id: 'env-1', name: 'lobster' }])
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'repo.list') {
      return {
        id: 'rpc-repo-list',
        ok: true,
        result: { repos: [remoteRepo] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'projectGroup.list') {
      return {
        id: 'rpc-project-group-list',
        ok: true,
        result: { groups: [remoteProjectGroup] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'folderWorkspace.list') {
      return {
        id: 'rpc-folder-workspace-list',
        ok: true,
        result: { folderWorkspaces: [remoteFolderWorkspace] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    return {
      id: 'rpc-other',
      ok: true,
      result: { projects: [], setups: [] },
      _meta: { runtimeId: 'runtime-remote' }
    }
  })
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })

  vi.stubGlobal('window', {
    api: {
      repos: { list: reposList },
      projects: { list: projectsList, listHostSetups: listHostSetups },
      projectGroups: { list: projectGroupsList },
      folderWorkspaces: { list: folderWorkspacesList },
      runtimeEnvironments: {
        call: runtimeEnvironmentTransportCall,
        list: runtimeEnvironmentsList
      }
    },
    dispatchEvent: dispatchEventMock
  })
})

function configureSharedProjectCompatibilityMocks(
  options: {
    localRepoHasProviderIdentity?: boolean
    remoteProjectRuntimePreference?: Project['localWindowsRuntimePreference']
  } = {}
): {
  sharedProjectId: string
  sharedRemoteProject: Project
} {
  const sharedProjectId = 'github:stablyai/orca'
  const localRepoForSharedProject: Repo =
    options.localRepoHasProviderIdentity === false
      ? localRepo
      : {
          ...localRepo,
          upstream: { owner: 'stablyai', repo: 'orca' }
        }
  const remoteRepoWithIdentity: Repo = {
    ...remoteRepo,
    upstream: { owner: 'stablyai', repo: 'orca' }
  }
  const sharedLocalProject: Project = {
    id: sharedProjectId,
    displayName: 'Orca',
    badgeColor: '#000',
    sourceRepoIds: ['local-repo'],
    localWindowsRuntimePreference: { kind: 'windows-host' },
    createdAt: 1,
    updatedAt: 1
  }
  const sharedRemoteProject: Project = {
    id: sharedProjectId,
    displayName: 'Orca',
    badgeColor: '#111',
    sourceRepoIds: ['remote-repo'],
    ...(options.remoteProjectRuntimePreference
      ? { localWindowsRuntimePreference: options.remoteProjectRuntimePreference }
      : {}),
    createdAt: 2,
    updatedAt: 2
  }
  const sharedLocalSetup: ProjectHostSetup = {
    ...localProjectHostSetup,
    projectId: sharedProjectId
  }
  const sharedRemoteSetup: ProjectHostSetup = {
    ...localProjectHostSetup,
    id: 'remote-setup',
    projectId: sharedProjectId,
    repoId: 'remote-repo',
    path: '/srv/repo',
    displayName: 'Remote setup'
  }
  reposList.mockResolvedValue([localRepoForSharedProject])
  projectsList.mockResolvedValue([sharedLocalProject])
  listHostSetups.mockResolvedValue([sharedLocalSetup])
  runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    if (args.method === 'repo.list') {
      return {
        id: 'rpc-repo-list',
        ok: true,
        result: { repos: [remoteRepoWithIdentity] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'project.list') {
      return {
        id: 'rpc-project-list',
        ok: true,
        result: { projects: [sharedRemoteProject] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    if (args.method === 'projectHostSetup.list') {
      return {
        id: 'rpc-project-host-setup-list',
        ok: true,
        result: { setups: [sharedRemoteSetup] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    }
    return {
      id: 'rpc-other',
      ok: true,
      result: {},
      _meta: { runtimeId: 'runtime-remote' }
    }
  })
  return { sharedProjectId, sharedRemoteProject }
}

function expectSharedProjectMetadata(projects: readonly Project[], sharedProjectId: string): void {
  const sharedProject = projects.find((project) => project.id === sharedProjectId)
  expect([...(sharedProject?.sourceRepoIds ?? [])].sort()).toEqual(['local-repo', 'remote-repo'])
  expect(sharedProject?.localWindowsRuntimePreference).toEqual({ kind: 'windows-host' })
}

describe('fetchReposForAllHosts', () => {
  it('loads local + all configured runtime environments even when a remote env is active', async () => {
    // Why: a cold start that restored a remote workspace leaves the remote
    // environment active. The active-host-only fetchRepos would drop local
    // repos entirely; fetchReposForAllHosts must surface both.
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    const ids = store
      .getState()
      .repos.map((repo) => repo.id)
      .sort()
    expect(ids).toEqual(['local-repo', 'remote-repo'])
    expect(store.getState().projects).toContainEqual(localProject)
    expect(store.getState().projectHostSetups).toContainEqual(localProjectHostSetup)
  })

  it('preserves runtime-owned project metadata during a local-only repo refresh', async () => {
    const runtimeProject: Project = {
      id: 'repo:remote-repo',
      displayName: 'Runtime API project',
      badgeColor: '#abc',
      sourceRepoIds: ['remote-repo'],
      createdAt: 3,
      updatedAt: 4
    }
    const runtimeSetup: ProjectHostSetup = {
      ...localProjectHostSetup,
      id: 'runtime-setup',
      projectId: runtimeProject.id,
      repoId: 'remote-repo',
      path: '/srv/repo',
      displayName: 'Runtime setup',
      setupState: 'ready',
      createdAt: 3,
      updatedAt: 4
    }
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repo-list',
          ok: true,
          result: { repos: [remoteRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'project.list') {
        return {
          id: 'rpc-project-list',
          ok: true,
          result: { projects: [runtimeProject] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'projectHostSetup.list') {
        return {
          id: 'rpc-project-host-setup-list',
          ok: true,
          result: { setups: [runtimeSetup] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchRepos()

    expect(
      store
        .getState()
        .projects.map((project) => project.id)
        .sort()
    ).toEqual(['local-project', 'repo:remote-repo'])
    expect(store.getState().projects.find((project) => project.id === runtimeProject.id)).toEqual(
      expect.objectContaining({
        displayName: runtimeProject.displayName,
        badgeColor: runtimeProject.badgeColor
      })
    )
  })

  it('does not backfill another host repo-derived project during runtime-only refresh', async () => {
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expect(
      store
        .getState()
        .projects.map((project) => project.id)
        .sort()
    ).toEqual(['local-project', 'repo:remote-repo'])
    expect(store.getState().projects).toContainEqual(localProject)
  })

  it('preserves shared project metadata when the same project id is fetched from multiple hosts', async () => {
    const { sharedProjectId } = configureSharedProjectCompatibilityMocks()
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    expectSharedProjectMetadata(store.getState().projects, sharedProjectId)
    expect(store.getState().projectHostSetups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: sharedProjectId,
          hostId: 'local',
          repoId: 'local-repo'
        }),
        expect.objectContaining({
          projectId: sharedProjectId,
          hostId: 'runtime:env-1',
          repoId: 'remote-repo'
        })
      ])
    )
  })

  it('keeps local Windows runtime preference when remote project metadata has its own preference', async () => {
    const { sharedProjectId } = configureSharedProjectCompatibilityMocks({
      remoteProjectRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    expect(
      store.getState().projects.find((project) => project.id === sharedProjectId)
        ?.localWindowsRuntimePreference
    ).toEqual({ kind: 'windows-host' })
  })

  it('preserves shared project metadata after a runtime-only repo refresh', async () => {
    const { sharedProjectId } = configureSharedProjectCompatibilityMocks()
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()
    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expectSharedProjectMetadata(store.getState().projects, sharedProjectId)
  })

  it('keeps the local side of a shared project when a runtime refresh removes its repos', async () => {
    const { sharedProjectId } = configureSharedProjectCompatibilityMocks()
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repo-list-empty',
          ok: true,
          result: { repos: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'project.list') {
        return {
          id: 'rpc-project-list-empty',
          ok: true,
          result: { projects: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'projectHostSetup.list') {
        return {
          id: 'rpc-project-host-setup-list-empty',
          ok: true,
          result: { setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    const sharedProject = store
      .getState()
      .projects.find((project) => project.id === sharedProjectId)
    expect(sharedProject?.sourceRepoIds).toEqual(['local-repo'])
    expect(sharedProject?.localWindowsRuntimePreference).toEqual({ kind: 'windows-host' })
    expect(store.getState().projectHostSetups).toEqual([
      expect.objectContaining({
        projectId: sharedProjectId,
        hostId: 'local',
        repoId: 'local-repo'
      })
    ])
  })

  it('preserves API-owned local shared projects when repo identity cannot re-derive them', async () => {
    const { sharedProjectId } = configureSharedProjectCompatibilityMocks({
      localRepoHasProviderIdentity: false
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()
    expectSharedProjectMetadata(store.getState().projects, sharedProjectId)
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repo-list-empty',
          ok: true,
          result: { repos: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'project.list') {
        return {
          id: 'rpc-project-list-empty',
          ok: true,
          result: { projects: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'projectHostSetup.list') {
        return {
          id: 'rpc-project-host-setup-list-empty',
          ok: true,
          result: { setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expect(store.getState().projects.map((project) => project.id)).toEqual([sharedProjectId])
    expect(
      store.getState().projects.find((project) => project.id === sharedProjectId)?.sourceRepoIds
    ).toEqual(['local-repo'])
    expect(store.getState().projectHostSetups).toEqual([
      expect.objectContaining({
        projectId: sharedProjectId,
        hostId: 'local',
        repoId: 'local-repo'
      })
    ])
  })

  it('drops refreshed-host source ownership when that repo no longer matches a shared project', async () => {
    const { sharedProjectId } = configureSharedProjectCompatibilityMocks()
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repo-list-reassigned',
          ok: true,
          result: { repos: [remoteRepo] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'project.list') {
        return {
          id: 'rpc-project-list-empty',
          ok: true,
          result: { projects: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'projectHostSetup.list') {
        return {
          id: 'rpc-project-host-setup-list-empty',
          ok: true,
          result: { setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expect(
      store.getState().projects.find((project) => project.id === sharedProjectId)?.sourceRepoIds
    ).toEqual(['local-repo'])
    expect(
      store
        .getState()
        .projects.map((project) => project.id)
        .sort()
    ).toEqual(['github:stablyai/orca', 'repo:remote-repo'])
    expect(store.getState().projectHostSetups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projectId: sharedProjectId,
          hostId: 'local',
          repoId: 'local-repo'
        }),
        expect.objectContaining({
          projectId: 'repo:remote-repo',
          hostId: 'runtime:env-1',
          repoId: 'remote-repo'
        })
      ])
    )
  })

  it('drops stale runtime repo ownership when project metadata lags behind repo removal', async () => {
    const { sharedProjectId, sharedRemoteProject } = configureSharedProjectCompatibilityMocks()
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        return {
          id: 'rpc-repo-list-empty',
          ok: true,
          result: { repos: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'project.list') {
        return {
          id: 'rpc-project-list-stale',
          ok: true,
          result: { projects: [sharedRemoteProject] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (args.method === 'projectHostSetup.list') {
        return {
          id: 'rpc-project-host-setup-list-empty',
          ok: true,
          result: { setups: [] },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-remote' }
      }
    })

    await store.getState().fetchRuntimeEnvironmentRepos('env-1')

    expect(
      store.getState().projects.find((project) => project.id === sharedProjectId)?.sourceRepoIds
    ).toEqual(['local-repo'])
  })

  it('fails soft when a runtime environment is unreachable, keeping local repos', async () => {
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'repo.list') {
        throw new Error('runtime_unreachable')
      }
      return {
        id: 'rpc-other',
        ok: true,
        result: { projects: [], setups: [] },
        _meta: { runtimeId: 'runtime-remote' }
      }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchReposForAllHosts()

    expect(store.getState().repos.map((repo) => repo.id)).toEqual(['local-repo'])
  })

  it('can load only the local catalog slice for first-paint startup', async () => {
    const store = createTestStore()

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })
    await store.getState().fetchProjectGroupsForAllHosts({ remoteHosts: 'skip' })
    await store.getState().fetchFolderWorkspacesForAllHosts({ remoteHosts: 'skip' })

    expect(runtimeEnvironmentsList).not.toHaveBeenCalled()
    expect(runtimeEnvironmentTransportCall).not.toHaveBeenCalled()
    expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }])
    expect(store.getState().projectGroups).toEqual([
      { ...localProjectGroup, executionHostId: 'local' }
    ])
    expect(store.getState().folderWorkspaces).toEqual([localFolderWorkspace])
  })

  it('preserves remote repo filters during first-paint local catalog refresh', async () => {
    const store = createTestStore()
    const remoteDismissalKey = getSetupScriptPromptDismissalKey('remote-repo')
    const staleDismissalKey = getSetupScriptPromptDismissalKey('stale-repo')
    store.setState({
      activeRepoId: 'remote-repo',
      filterRepoIds: ['remote-repo', 'stale-repo'],
      setupScriptPromptDismissedRepoIds: [remoteDismissalKey, staleDismissalKey],
      trustedOrcaHooks: {
        'remote-repo': { all: { approvedAt: 1 } },
        'stale-repo': { all: { approvedAt: 2 } }
      }
    })

    await store.getState().fetchReposForAllHosts({ remoteHosts: 'skip' })

    expect(store.getState().activeRepoId).toBe('remote-repo')
    expect(store.getState().filterRepoIds).toEqual(['remote-repo', 'stale-repo'])
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([
      remoteDismissalKey,
      staleDismissalKey
    ])
    expect(store.getState().trustedOrcaHooks).toEqual({
      'remote-repo': { all: { approvedAt: 1 } },
      'stale-repo': { all: { approvedAt: 2 } }
    })

    await store.getState().fetchReposForAllHosts()

    expect(store.getState().activeRepoId).toBe('remote-repo')
    expect(store.getState().filterRepoIds).toEqual(['remote-repo'])
    expect(store.getState().setupScriptPromptDismissedRepoIds).toEqual([remoteDismissalKey])
    expect(store.getState().trustedOrcaHooks).toEqual({
      'remote-repo': { all: { approvedAt: 1 } }
    })
  })

  it('starts remote repo catalog loads concurrently for all configured runtimes', async () => {
    runtimeEnvironmentsList.mockResolvedValue([
      { id: 'env-1', name: 'first' },
      { id: 'env-2', name: 'second' }
    ])
    const firstStatusResolvers = new Map<string, (value: unknown) => void>()
    let resolveBothStatusProbes = (): void => {}
    const bothStatusProbesStarted = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Timed out waiting for both runtime probes')),
        1_000
      )
      resolveBothStatusProbes = () => {
        clearTimeout(timeout)
        resolve()
      }
    })
    runtimeEnvironmentTransportCall.mockImplementation(
      (args: RuntimeEnvironmentCallRequest & { selector?: string }) => {
        if (
          args.method === 'status.get' &&
          args.selector &&
          !firstStatusResolvers.has(args.selector)
        ) {
          return new Promise((resolve) => {
            firstStatusResolvers.set(args.selector!, resolve)
            if (firstStatusResolvers.size === 2) {
              resolveBothStatusProbes()
            }
          })
        }
        return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
      }
    )
    const store = createTestStore()

    const load = store.getState().fetchReposForAllHosts()
    await bothStatusProbesStarted

    expect([...firstStatusResolvers.keys()].sort()).toEqual(['env-1', 'env-2'])
    for (const resolve of firstStatusResolvers.values()) {
      resolve(createCompatibleRuntimeStatusResponseIfNeeded({ method: 'status.get' }))
    }
    await load

    expect(
      store
        .getState()
        .repos.map((repo) => `${repo.id}:${repo.executionHostId}`)
        .sort()
    ).toEqual(['local-repo:local', 'remote-repo:runtime:env-1', 'remote-repo:runtime:env-2'])
  })
})
