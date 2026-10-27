import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { getProjectHostSetupProjectionFromState } from '../project-host-setup-selector'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

export function registerReposProjectRuntimeTests(): void {
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
        endpointProjects: [project],
        detectedAgentIds: ['claude'],
        isDetectingAgents: true,
        isRefreshingAgents: true
      })

      await store.getState().updateProject(
        project.id,
        {
          localWindowsRuntimePreference: { kind: 'windows-host' }
        },
        'local'
      )

      expect(store.getState().detectedAgentIds).toBeNull()
      expect(store.getState().isDetectingAgents).toBe(false)
      expect(store.getState().isRefreshingAgents).toBe(false)
      expectInstalledSkillRefreshEvent()
    })

    it('updates an old endpoint by its concrete advertised project and rehydrates the split view', async () => {
      const repos = ['a', 'b'].map((id, index) => ({
        ...localRepo,
        id,
        path: `/${id}`,
        addedAt: index + 1,
        executionHostId: 'runtime:old' as const,
        upstream: { owner: 'acme', repo: 'app' }
      }))
      const projection = projectHostSetupProjectionFromRepos(repos)
      const rawProject = {
        ...projection.projects[0],
        id: 'github:acme/app',
        sourceRepoIds: ['a', 'b']
      }
      runtimeEnvironmentCall.mockImplementation(async (args) => {
        expect(args).toMatchObject({
          selector: 'old',
          method: 'project.update',
          params: {
            projectId: rawProject.id,
            updates: { localWindowsRuntimePreference: { kind: 'windows-host' } }
          }
        })
        return {
          id: 'update',
          ok: true,
          result: {
            project: { ...rawProject, localWindowsRuntimePreference: { kind: 'windows-host' } }
          }
        }
      })
      const store = createTestStore()
      store.setState({
        repos,
        endpointProjects: [rawProject],
        endpointProjectHostSetups: projection.setups.map((setup) => ({
          ...setup,
          projectId: rawProject.id
        }))
      })
      expect(
        await store
          .getState()
          .updateProject(
            'repo:b',
            { localWindowsRuntimePreference: { kind: 'windows-host' } },
            'runtime:old'
          )
      ).toBe(true)
      const view = getProjectHostSetupProjectionFromState(store.getState())
      expect(view.setups.find((setup) => setup.repoId === 'b')?.projectId).toBe('repo:b')
      expect(
        view.projects.find((project) => project.id === 'repo:b')?.localWindowsRuntimePreference
      ).toEqual({ kind: 'windows-host' })
      expect(
        store
          .getState()
          .endpointProjectHostSetups.every((setup) => setup.projectId === rawProject.id)
      ).toBe(true)
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

      await store.getState().fetchRepos(catalogOwner(store))

      expect(store.getState().endpointProjects).toEqual([project])
      expect(store.getState().endpointProjectHostSetups).toEqual([setup])
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
      store.setState({ endpointProjects: [staleProject], endpointProjectHostSetups: [setup] })

      await store.getState().fetchRepos(catalogOwner(store))

      expect(store.getState().endpointProjects[0]?.localWindowsRuntimePreference).toBeUndefined()
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
      store.setState({ endpointProjects: [project] })

      await store.getState().updateProject(
        project.id,
        {
          localWindowsRuntimePreference: { kind: 'windows-host' }
        },
        'local'
      )

      expect(store.getState().endpointProjects[0]?.localWindowsRuntimePreference).toEqual({
        kind: 'windows-host'
      })
      expect(projectsUpdate).toHaveBeenCalledWith({
        projectId: project.id,
        updates: { localWindowsRuntimePreference: { kind: 'windows-host' } }
      })
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    })

    it('updates a local project on this computer even while a server with a setup is the default host', async () => {
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
        settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
        endpointProjects: [project],
        endpointProjectHostSetups: [
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

      await store
        .getState()
        .updateProject(
          project.id,
          { localWindowsRuntimePreference: { kind: 'windows-host' } },
          'local'
        )

      expect(projectsUpdate).toHaveBeenCalledWith({
        projectId: project.id,
        updates: { localWindowsRuntimePreference: { kind: 'windows-host' } }
      })
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    })

    it('updates remote project runtime preferences through the owning runtime', async () => {
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
        endpointProjects: [project],
        endpointProjectHostSetups: [
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

      await store.getState().updateProject(
        project.id,
        {
          localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
        },
        'runtime:env-1'
      )

      expect(store.getState().endpointProjects[0]?.localWindowsRuntimePreference).toEqual({
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

    // Missing addedAt yields unknown createdAt=0, not epoch; merge must keep real timestamp from another host.
    it('prefers a known createdAt over an unknown 0 when merging the same project id', async () => {
      const project: Project = {
        id: 'github:stablyai/orca',
        displayName: 'Orca',
        badgeColor: '#000',
        sourceRepoIds: ['remote-repo'],
        createdAt: 0,
        updatedAt: 0
      }
      projectsUpdate.mockResolvedValue({
        ...project,
        sourceRepoIds: ['local-repo'],
        createdAt: 100,
        updatedAt: 100,
        localWindowsRuntimePreference: { kind: 'windows-host' }
      })
      const store = createTestStore()
      store.setState({ endpointProjects: [project] })

      await store.getState().updateProject(
        project.id,
        {
          localWindowsRuntimePreference: { kind: 'windows-host' }
        },
        'local'
      )

      expect(store.getState().endpointProjects[0]?.createdAt).toBe(100)
      expect(store.getState().endpointProjects[0]?.updatedAt).toBe(100)
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
      store.setState({ endpointProjects: [project] })

      await store.getState().updateProject(
        project.id,
        {
          localWindowsRuntimePreference: { kind: 'windows-host' }
        },
        'local'
      )

      expect(store.getState().endpointProjects[0]?.sourceRepoIds).toEqual([
        'local-repo',
        'remote-repo'
      ])
      expect(store.getState().endpointProjects[0]?.localWindowsRuntimePreference).toEqual({
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
      store.setState({ endpointProjects: [project] })

      await store.getState().updateProject(
        project.id,
        {
          localWindowsRuntimePreference: undefined
        },
        'local'
      )

      expect(store.getState().endpointProjects[0]?.sourceRepoIds).toEqual([
        'local-repo',
        'remote-repo'
      ])
      expect(store.getState().endpointProjects[0]?.localWindowsRuntimePreference).toBeUndefined()
    })
  })

  // The catalog these tests read is the one the focused host would have shown.
  function catalogOwner(store: {
    getState: () => { settings: { activeRuntimeEnvironmentId?: string | null } | null }
  }): { runtimeEnvironmentId: string | null } {
    return { runtimeEnvironmentId: store.getState().settings?.activeRuntimeEnvironmentId ?? null }
  }
}
