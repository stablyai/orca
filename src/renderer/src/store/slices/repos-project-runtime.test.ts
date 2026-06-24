import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
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

const projectsList = vi.fn()
const projectsUpdate = vi.fn()
const projectsCreateHostSetup = vi.fn()
const projectsSetupExistingFolder = vi.fn()
const projectsUpdateHostSetup = vi.fn()
const projectsDeleteHostSetup = vi.fn()
const reposList = vi.fn()
const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const dispatchEventMock = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  projectsList.mockReset()
  projectsUpdate.mockReset()
  projectsCreateHostSetup.mockReset()
  projectsSetupExistingFolder.mockReset()
  projectsUpdateHostSetup.mockReset()
  projectsDeleteHostSetup.mockReset()
  reposList.mockReset()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  dispatchEventMock.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      repos: {
        list: reposList
      },
      projects: {
        list: projectsList,
        update: projectsUpdate,
        listHostSetups: vi.fn(),
        createHostSetup: projectsCreateHostSetup,
        setupExistingFolder: projectsSetupExistingFolder,
        updateHostSetup: projectsUpdateHostSetup,
        deleteHostSetup: projectsDeleteHostSetup
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    },
    dispatchEvent: dispatchEventMock
  })
})

function expectInstalledSkillRefreshEvent(): void {
  expect(
    dispatchEventMock.mock.calls.some(([event]) => {
      return event instanceof CustomEvent && event.type === 'orca:installed-agent-skills-changed'
    })
  ).toBe(true)
}

describe('repo slice project runtime updates', () => {
  it('clears local runtime-scoped detection state when project runtime changes', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    projectsUpdate.mockResolvedValue({
      ...project,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })
    const store = createTestStore()
    store.setState({
      projects: [project],
      detectedAgentIds: ['claude'],
      isDetectingAgents: true,
      isRefreshingAgents: true
    })

    await store.getState().updateProject(project.id, {
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    expect(store.getState().detectedAgentIds).toBeNull()
    expect(store.getState().isDetectingAgents).toBe(false)
    expect(store.getState().isRefreshingAgents).toBe(false)
    expectInstalledSkillRefreshEvent()
  })

  it('hydrates projects from local IPC when the project API is available', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    const setup: ProjectHostSetup = {
      id: 'setup-1',
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
    projectsList.mockResolvedValue([project])
    window.api.projects.listHostSetups = vi.fn().mockResolvedValue([setup])
    reposList.mockResolvedValue([localRepo])
    const store = createTestStore()

    await store.getState().fetchRepos()

    expect(store.getState().projects).toEqual([project])
    expect(store.getState().projectHostSetups).toEqual([setup])
    expect(projectsList).toHaveBeenCalled()
    expect(window.api.projects.listHostSetups).toHaveBeenCalled()
  })

  it('clears stale local runtime preferences when local project refresh omits them', async () => {
    const staleProject: Project = {
      id: 'local-project',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo'],
      localWindowsRuntimePreference: { kind: 'windows-host' },
      createdAt: 1,
      updatedAt: 1
    }
    const refreshedProject: Project = {
      id: staleProject.id,
      displayName: staleProject.displayName,
      badgeColor: staleProject.badgeColor,
      sourceRepoIds: ['local-repo'],
      createdAt: 1,
      updatedAt: 2
    }
    const setup: ProjectHostSetup = {
      id: 'setup-1',
      projectId: staleProject.id,
      hostId: 'local',
      repoId: 'local-repo',
      path: '/local',
      displayName: 'Local',
      setupState: 'ready',
      setupMethod: 'legacy-repo',
      createdAt: 1,
      updatedAt: 1
    }
    projectsList.mockResolvedValue([refreshedProject])
    window.api.projects.listHostSetups = vi.fn().mockResolvedValue([setup])
    reposList.mockResolvedValue([localRepo])
    const store = createTestStore()
    store.setState({ projects: [staleProject], projectHostSetups: [setup] })

    await store.getState().fetchRepos()

    expect(store.getState().projects[0]?.localWindowsRuntimePreference).toBeUndefined()
  })

  it('updates local project runtime preferences through the projects API', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    projectsUpdate.mockResolvedValue({
      ...project,
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })
    const store = createTestStore()
    store.setState({ projects: [project] })

    await store.getState().updateProject(project.id, {
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    expect(store.getState().projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'windows-host'
    })
    expect(projectsUpdate).toHaveBeenCalledWith({
      projectId: project.id,
      updates: { localWindowsRuntimePreference: { kind: 'windows-host' } }
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('updates remote project runtime preferences through the active runtime', async () => {
    const project: Project = {
      id: 'project-1',
      displayName: 'Project',
      badgeColor: '#000',
      sourceRepoIds: ['remote-repo'],
      createdAt: 1,
      updatedAt: 1
    }
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-project-update',
      ok: true,
      result: {
        project: {
          ...project,
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        }
      },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      projects: [project],
      projectHostSetups: [
        {
          id: 'setup-1',
          projectId: project.id,
          hostId: 'runtime:env-1',
          repoId: 'remote-repo',
          path: '/srv/repo',
          displayName: 'Remote',
          setupState: 'ready',
          setupMethod: 'imported-existing-folder',
          createdAt: 1,
          updatedAt: 1
        }
      ]
    })

    await store.getState().updateProject(project.id, {
      localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
    })

    expect(store.getState().projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'wsl',
      distro: 'Ubuntu'
    })
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'project.update',
      params: {
        projectId: project.id,
        updates: { localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' } }
      },
      timeoutMs: 15_000
    })
    expect(projectsUpdate).not.toHaveBeenCalled()
  })

  it('preserves shared project source repos when updating local runtime preferences', async () => {
    const project: Project = {
      id: 'github:stablyai/orca',
      displayName: 'Orca',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo', 'remote-repo'],
      createdAt: 1,
      updatedAt: 2
    }
    projectsUpdate.mockResolvedValue({
      ...project,
      sourceRepoIds: ['local-repo'],
      localWindowsRuntimePreference: { kind: 'windows-host' },
      updatedAt: 3
    })
    const store = createTestStore()
    store.setState({ projects: [project] })

    await store.getState().updateProject(project.id, {
      localWindowsRuntimePreference: { kind: 'windows-host' }
    })

    expect(store.getState().projects[0]?.sourceRepoIds).toEqual(['local-repo', 'remote-repo'])
    expect(store.getState().projects[0]?.localWindowsRuntimePreference).toEqual({
      kind: 'windows-host'
    })
  })

  it('clears local runtime preferences without dropping shared project source repos', async () => {
    const project: Project = {
      id: 'github:stablyai/orca',
      displayName: 'Orca',
      badgeColor: '#000',
      sourceRepoIds: ['local-repo', 'remote-repo'],
      localWindowsRuntimePreference: { kind: 'windows-host' },
      createdAt: 1,
      updatedAt: 2
    }
    projectsUpdate.mockResolvedValue({
      id: project.id,
      displayName: project.displayName,
      badgeColor: project.badgeColor,
      sourceRepoIds: ['local-repo'],
      createdAt: project.createdAt,
      updatedAt: 3
    })
    const store = createTestStore()
    store.setState({ projects: [project] })

    await store.getState().updateProject(project.id, {
      localWindowsRuntimePreference: undefined
    })

    expect(store.getState().projects[0]?.sourceRepoIds).toEqual(['local-repo', 'remote-repo'])
    expect(store.getState().projects[0]?.localWindowsRuntimePreference).toBeUndefined()
  })
})
