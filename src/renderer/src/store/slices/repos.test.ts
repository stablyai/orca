import { describe, expect, it, vi, beforeEach } from 'vitest'
import { createTestStore, makeWorktree } from './store-test-helpers'
import { workItemsCacheKey } from './github'
import type { Project, ProjectHostSetup, Repo } from '../../../../shared/types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

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

const sshRepo: Repo = {
  id: 'ssh-repo',
  path: '/home/orca/project',
  displayName: 'SSH',
  badgeColor: '#222',
  addedAt: 3,
  connectionId: 'ssh-1'
}

const reposList = vi.fn()
const reposAdd = vi.fn()
const reposPickFolder = vi.fn()
const reposClone = vi.fn()
const reposCloneRemote = vi.fn()
const reposRemove = vi.fn()
const reposUpdate = vi.fn()
const reposReorder = vi.fn()
const projectsCreateHostSetup = vi.fn()
const projectsSetupExistingFolder = vi.fn()
const projectsUpdateHostSetup = vi.fn()
const projectsDeleteHostSetup = vi.fn()
const projectsUpdate = vi.fn()
const projectGroupsMoveProject = vi.fn()
const ptyKill = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  reposList.mockReset()
  reposAdd.mockReset()
  reposPickFolder.mockReset()
  reposClone.mockReset()
  reposCloneRemote.mockReset()
  reposRemove.mockReset()
  reposUpdate.mockReset()
  reposReorder.mockReset()
  projectsCreateHostSetup.mockReset()
  projectsSetupExistingFolder.mockReset()
  projectsUpdateHostSetup.mockReset()
  projectsDeleteHostSetup.mockReset()
  projectsUpdate.mockReset()
  projectGroupsMoveProject.mockReset()
  ptyKill.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList,
        add: reposAdd,
        clone: reposClone,
        cloneRemote: reposCloneRemote,
        pickFolder: reposPickFolder,
        remove: reposRemove,
        update: reposUpdate,
        reorder: reposReorder
      },
      projects: {
        update: projectsUpdate,
        createHostSetup: projectsCreateHostSetup,
        setupExistingFolder: projectsSetupExistingFolder,
        updateHostSetup: projectsUpdateHostSetup,
        deleteHostSetup: projectsDeleteHostSetup
      },
      projectGroups: {
        moveProject: projectGroupsMoveProject
      },
      pty: { kill: ptyKill },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice runtime routing', () => {
  it('fetches repos from local IPC when no remote environment is active', async () => {
    reposList.mockResolvedValue([localRepo])
    const store = createTestStore()

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }])
    expect(store.getState().projects).toEqual([
      expect.objectContaining({ id: 'repo:local-repo', sourceRepoIds: ['local-repo'] })
    ])
    expect(store.getState().projectHostSetups).toEqual([
      expect.objectContaining({ id: 'local-repo', hostId: 'local' })
    ])
    expect(reposList).toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('fetches repos from the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { repos: [remoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      activeRepoId: 'stale-repo',
      filterRepoIds: ['remote-repo', 'stale-repo']
    })

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([{ ...remoteRepo, executionHostId: 'runtime:env-1' }])
    expect(store.getState().projects).toEqual([
      expect.objectContaining({ id: 'repo:remote-repo', sourceRepoIds: ['remote-repo'] })
    ])
    expect(store.getState().projectHostSetups).toEqual([
      expect.objectContaining({ id: 'remote-repo', hostId: 'runtime:env-1' })
    ])
    expect(store.getState().activeRepoId).toBeNull()
    expect(store.getState().filterRepoIds).toEqual(['remote-repo'])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.list',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(reposList).not.toHaveBeenCalled()
  })

  it('stamps runtime-fetched SSH repos with the runtime owner', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-ssh-repo',
      ok: true,
      result: { repos: [{ ...remoteRepo, connectionId: 'ssh-1' }] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchRepos()

    expect(store.getState().repos).toEqual([
      { ...remoteRepo, connectionId: 'ssh-1', executionHostId: 'runtime:env-1' }
    ])
  })

  it('updates repos through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-2',
      ok: true,
      result: { repo: { ...remoteRepo, displayName: 'Renamed' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo]
    })

    await store.getState().updateRepo(remoteRepo.id, { displayName: 'Renamed' })

    expect(store.getState().repos[0]?.displayName).toBe('Renamed')
    expect(store.getState().repos[0]?.executionHostId).toBe('runtime:env-1')
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.update',
      params: { repo: remoteRepo.id, updates: { displayName: 'Renamed' } },
      timeoutMs: 15_000
    })
    expect(reposUpdate).not.toHaveBeenCalled()
  })

  it('updates SSH-owned repos through local IPC even when a runtime is focused', async () => {
    reposUpdate.mockResolvedValue({ ...sshRepo, displayName: 'SSH Renamed' })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [sshRepo]
    })

    await store.getState().updateRepo(sshRepo.id, { displayName: 'SSH Renamed' })

    expect(store.getState().repos[0]?.displayName).toBe('SSH Renamed')
    expect(reposUpdate).toHaveBeenCalledWith({
      repoId: sshRepo.id,
      updates: { displayName: 'SSH Renamed' }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('adds explicit server paths through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-add',
      ok: true,
      result: { repo: remoteRepo },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never
    })

    await expect(store.getState().addRepoPath('/srv/project', 'folder')).resolves.toEqual({
      ...remoteRepo,
      executionHostId: 'runtime:env-1'
    })

    expect(store.getState().repos).toEqual([{ ...remoteRepo, executionHostId: 'runtime:env-1' }])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.add',
      params: { path: '/srv/project', kind: 'folder' },
      timeoutMs: 15_000
    })
    expect(reposAdd).not.toHaveBeenCalled()
    expect(reposPickFolder).not.toHaveBeenCalled()
  })

  it('sets up a project on a local host through the project setup API', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    const setup: ProjectHostSetup = {
      id: 'local-repo',
      projectId: project.id,
      hostId: 'local',
      repoId: 'local-repo',
      path: '/local',
      displayName: 'Local',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
    projectsSetupExistingFolder.mockResolvedValue({ project, setup, repo: localRepo })
    const store = createTestStore()

    await expect(
      store.getState().setupProjectExistingFolder({
        projectId: project.id,
        hostId: 'local',
        path: '/local',
        kind: 'git'
      })
    ).resolves.toEqual({
      project,
      setup,
      repo: { ...localRepo, executionHostId: 'local' }
    })

    expect(store.getState().repos).toEqual([{ ...localRepo, executionHostId: 'local' }])
    expect(store.getState().projects).toEqual([project])
    expect(store.getState().projectHostSetups).toEqual([setup])
    expect(projectsSetupExistingFolder).toHaveBeenCalledWith({
      projectId: project.id,
      hostId: 'local',
      path: '/local',
      kind: 'git'
    })
  })

  it('sets up a project on the active runtime host through runtime RPC', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['remote-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    const setup: ProjectHostSetup = {
      id: 'remote-repo',
      projectId: project.id,
      hostId: 'local',
      repoId: 'remote-repo',
      path: '/srv/project',
      displayName: 'Remote',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-setup',
      ok: true,
      result: { result: { project, setup, repo: remoteRepo } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await expect(
      store.getState().setupProjectExistingFolder({
        projectId: project.id,
        hostId: 'runtime:env-1',
        path: '/srv/project',
        kind: 'git'
      })
    ).resolves.toEqual({
      project,
      setup: { ...setup, hostId: 'runtime:env-1', executionHostId: 'runtime:env-1' },
      repo: { ...remoteRepo, executionHostId: 'runtime:env-1' }
    })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectHostSetup.setupExistingFolder',
      params: {
        projectId: project.id,
        hostId: 'runtime:env-1',
        path: '/srv/project',
        kind: 'git'
      },
      timeoutMs: 15_000
    })
  })

  it('sets up an SSH host through local IPC even when a runtime is focused', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['ssh-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    const setup: ProjectHostSetup = {
      id: 'ssh-repo',
      projectId: project.id,
      hostId: 'ssh:openclaw%202',
      repoId: 'ssh-repo',
      path: '/srv/project',
      displayName: 'Remote',
      connectionId: 'openclaw 2',
      setupState: 'ready',
      setupMethod: 'imported-existing-folder',
      createdAt: 1,
      updatedAt: 1
    }
    projectsSetupExistingFolder.mockResolvedValue({
      project,
      setup,
      repo: { ...remoteRepo, connectionId: 'openclaw 2' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await expect(
      store.getState().setupProjectExistingFolder({
        projectId: project.id,
        hostId: 'ssh:openclaw%202',
        path: '/srv/project',
        kind: 'git'
      })
    ).resolves.toEqual({
      project,
      setup,
      repo: { ...remoteRepo, connectionId: 'openclaw 2', executionHostId: 'ssh:openclaw%202' }
    })

    expect(projectsSetupExistingFolder).toHaveBeenCalledWith({
      projectId: project.id,
      hostId: 'ssh:openclaw%202',
      path: '/srv/project',
      kind: 'git'
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('clones a project locally before aligning it as a host setup', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    const clonedRepo = { ...localRepo, path: '/workspace/project' }
    const setup: ProjectHostSetup = {
      id: clonedRepo.id,
      projectId: project.id,
      hostId: 'local',
      repoId: clonedRepo.id,
      path: clonedRepo.path,
      displayName: clonedRepo.displayName,
      setupState: 'ready',
      setupMethod: 'cloned',
      createdAt: 1,
      updatedAt: 1
    }
    reposClone.mockResolvedValue(clonedRepo)
    projectsSetupExistingFolder.mockResolvedValue({ project, setup, repo: clonedRepo })
    const store = createTestStore()

    await expect(
      store.getState().setupProjectClone({
        projectId: project.id,
        hostId: 'local',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/workspace',
        displayName: 'Project'
      })
    ).resolves.toEqual({
      project,
      setup,
      repo: { ...clonedRepo, executionHostId: 'local' }
    })

    expect(reposClone).toHaveBeenCalledWith({
      url: 'https://github.com/stablyai/orca.git',
      destination: '/workspace'
    })
    expect(projectsSetupExistingFolder).toHaveBeenCalledWith({
      projectId: project.id,
      hostId: 'local',
      path: clonedRepo.path,
      kind: 'git',
      displayName: 'Project',
      setupMethod: 'cloned'
    })
  })

  it('clones a project on a runtime host before aligning it as a host setup', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['remote-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    const clonedRepo = { ...remoteRepo, path: '/srv/project' }
    const setup: ProjectHostSetup = {
      id: clonedRepo.id,
      projectId: project.id,
      hostId: 'local',
      repoId: clonedRepo.id,
      path: clonedRepo.path,
      displayName: clonedRepo.displayName,
      setupState: 'ready',
      setupMethod: 'cloned',
      createdAt: 1,
      updatedAt: 1
    }
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'rpc-clone',
        ok: true,
        result: { repo: clonedRepo },
        _meta: { runtimeId: 'runtime-remote' }
      })
      .mockResolvedValueOnce({
        id: 'rpc-setup',
        ok: true,
        result: { result: { project, setup, repo: clonedRepo } },
        _meta: { runtimeId: 'runtime-remote' }
      })
    const store = createTestStore()

    await expect(
      store.getState().setupProjectClone({
        projectId: project.id,
        hostId: 'runtime:env-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/srv',
        displayName: 'Project'
      })
    ).resolves.toEqual({
      project,
      setup: { ...setup, hostId: 'runtime:env-1', executionHostId: 'runtime:env-1' },
      repo: { ...clonedRepo, executionHostId: 'runtime:env-1' }
    })

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'repo.clone',
      params: {
        url: 'https://github.com/stablyai/orca.git',
        destination: '/srv'
      },
      timeoutMs: 10 * 60_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'projectHostSetup.setupExistingFolder',
      params: {
        projectId: project.id,
        hostId: 'runtime:env-1',
        path: clonedRepo.path,
        kind: 'git',
        displayName: 'Project',
        setupMethod: 'cloned'
      },
      timeoutMs: 15_000
    })
  })

  it('clones a project on an SSH host before aligning it as a host setup', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['ssh-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    const clonedRepo = { ...sshRepo, path: '/srv/project' }
    const setup: ProjectHostSetup = {
      id: clonedRepo.id,
      projectId: project.id,
      hostId: 'ssh:ssh-1',
      repoId: clonedRepo.id,
      path: clonedRepo.path,
      displayName: clonedRepo.displayName,
      setupState: 'ready',
      setupMethod: 'cloned',
      createdAt: 1,
      updatedAt: 1
    }
    reposCloneRemote.mockResolvedValue(clonedRepo)
    projectsSetupExistingFolder.mockResolvedValue({ project, setup, repo: clonedRepo })
    const store = createTestStore()

    await expect(
      store.getState().setupProjectClone({
        projectId: project.id,
        hostId: 'ssh:ssh-1',
        url: 'https://github.com/stablyai/orca.git',
        destination: '/srv',
        displayName: 'Project'
      })
    ).resolves.toEqual({
      project,
      setup,
      repo: { ...clonedRepo, executionHostId: 'ssh:ssh-1' }
    })

    expect(reposCloneRemote).toHaveBeenCalledWith({
      connectionId: 'ssh-1',
      url: 'https://github.com/stablyai/orca.git',
      destination: '/srv'
    })
    expect(projectsSetupExistingFolder).toHaveBeenCalledWith({
      projectId: project.id,
      hostId: 'ssh:ssh-1',
      path: clonedRepo.path,
      kind: 'git',
      displayName: 'Project',
      setupMethod: 'cloned'
    })
  })

  it('keeps runtime ownership when a runtime repo is moved between groups', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-move',
      ok: true,
      result: { repo: { ...remoteRepo, projectGroupId: 'group-1' } },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [{ ...remoteRepo, executionHostId: 'runtime:env-1' }]
    })

    await expect(store.getState().moveProjectToGroup(remoteRepo.id, 'group-1')).resolves.toBe(true)

    expect(store.getState().repos).toEqual([
      { ...remoteRepo, projectGroupId: 'group-1', executionHostId: 'runtime:env-1' }
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'projectGroup.moveProject',
      params: { repo: remoteRepo.id, groupId: 'group-1', order: undefined },
      timeoutMs: 15_000
    })
    expect(projectGroupsMoveProject).not.toHaveBeenCalled()
  })

  it('does not open the client folder picker when a remote runtime environment is active', async () => {
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never
    })

    await expect(store.getState().addRepo()).resolves.toBeNull()

    expect(reposPickFolder).not.toHaveBeenCalled()
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('removes repos through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-3',
      ok: true,
      result: { removed: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo],
      activeRepoId: remoteRepo.id
    })

    await store.getState().removeProject(remoteRepo.id)

    expect(store.getState().repos).toEqual([])
    expect(store.getState().activeRepoId).toBeNull()
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.rm',
      params: { repo: remoteRepo.id },
      timeoutMs: 15_000
    })
    expect(reposRemove).not.toHaveBeenCalled()
  })

  it('removes SSH-owned repos through local IPC even when a runtime is focused', async () => {
    const store = createTestStore()
    const worktreeId = `${sshRepo.id}::/home/orca/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [sshRepo],
      activeRepoId: sshRepo.id,
      worktreesByRepo: {
        [sshRepo.id]: [makeWorktree({ id: worktreeId, repoId: sshRepo.id })]
      }
    })

    await store.getState().removeProject(sshRepo.id)

    expect(store.getState().repos).toEqual([])
    expect(store.getState().activeRepoId).toBeNull()
    expect(reposRemove).toHaveBeenCalledWith({ repoId: sshRepo.id })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('evicts GitHub caches for removed repos using repo id and legacy path keys', async () => {
    const store = createTestStore()
    store.setState({
      repos: [localRepo],
      workItemsInvalidationNonce: 2,
      workItemsCache: {
        [workItemsCacheKey(localRepo.id, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey(localRepo.path, 20, '')]: { data: [], fetchedAt: 1 },
        [workItemsCacheKey('other-repo', 20, '')]: { data: [], fetchedAt: 1 }
      },
      prCache: {
        [`${localRepo.id}::branch`]: { data: {} as never, fetchedAt: 1 },
        [`${localRepo.path}::branch`]: { data: {} as never, fetchedAt: 1 },
        'other-repo::branch': { data: {} as never, fetchedAt: 1 }
      }
    })

    await store.getState().removeProject(localRepo.id)

    expect(Object.keys(store.getState().workItemsCache)).toEqual([
      workItemsCacheKey('other-repo', 20, '')
    ])
    expect(Object.keys(store.getState().prCache)).toEqual(['other-repo::branch'])
    expect(store.getState().workItemsInvalidationNonce).toBe(3)
  })

  it('stops remote runtime terminals instead of killing remote ids through local pty IPC', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-remote',
      ok: true,
      result: { ok: true },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    const worktreeId = `${remoteRepo.id}::/remote/wt`
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [remoteRepo],
      worktreesByRepo: {
        [remoteRepo.id]: [makeWorktree({ id: worktreeId, repoId: remoteRepo.id })]
      },
      tabsByWorktree: {
        [worktreeId]: [{ id: 'tab-1', worktreeId } as never]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:term-1', 'pty-local-stale']
      }
    })

    await store.getState().removeProject(remoteRepo.id)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'terminal.stop',
      params: { worktree: `id:${worktreeId}` },
      timeoutMs: 15_000
    })
    expect(ptyKill).toHaveBeenCalledWith('pty-local-stale')
    expect(ptyKill).not.toHaveBeenCalledWith('remote:term-1')
  })

  it('cleans up hidden detected worktree state when removing a repo', async () => {
    const store = createTestStore()
    const hiddenWorktree = makeWorktree({
      id: `${localRepo.id}::/local/hidden`,
      repoId: localRepo.id,
      path: '/local/hidden'
    })
    store.setState({
      repos: [localRepo],
      worktreesByRepo: { [localRepo.id]: [] },
      detectedWorktreesByRepo: {
        [localRepo.id]: {
          repoId: localRepo.id,
          authoritative: true,
          source: 'git',
          worktrees: [
            {
              ...hiddenWorktree,
              ownership: 'external',
              selectedCheckout: false,
              visible: false
            }
          ]
        }
      },
      tabsByWorktree: {
        [hiddenWorktree.id]: [{ id: 'tab-hidden', worktreeId: hiddenWorktree.id }] as never
      },
      ptyIdsByTabId: {
        'tab-hidden': ['pty-hidden']
      },
      activeWorktreeId: hiddenWorktree.id
    })

    await store.getState().removeProject(localRepo.id)

    expect(store.getState().detectedWorktreesByRepo[localRepo.id]).toBeUndefined()
    expect(store.getState().tabsByWorktree[hiddenWorktree.id]).toBeUndefined()
    expect(store.getState().activeWorktreeId).toBeNull()
    expect(ptyKill).toHaveBeenCalledWith('pty-hidden')
  })

  it('reorders repos through the active remote runtime environment', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-4',
      ok: true,
      result: { status: 'applied' },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      repos: [localRepo, remoteRepo]
    })

    await store.getState().reorderRepos([remoteRepo.id, localRepo.id])

    expect(store.getState().repos.map((repo) => repo.id)).toEqual([remoteRepo.id, localRepo.id])
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.reorder',
      params: { orderedIds: [remoteRepo.id, localRepo.id] },
      timeoutMs: 15_000
    })
    expect(reposReorder).not.toHaveBeenCalled()
  })
})
