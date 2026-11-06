import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Project } from '../../../../shared/project-types'
import { projectHostSetupProjectionFromRepos } from '../../../../shared/project-host-setup-projection'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

export function registerReposProjectDefaultAgentTests(): void {
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

  describe('repo slice project default agent updates', () => {
    it('does not display an unacknowledged project default from an older host', async () => {
      const project: Project = {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#000',
        sourceRepoIds: ['local-repo'],
        createdAt: 1,
        updatedAt: 1
      }
      const store = createTestStore()
      store.setState({ projects: [project] })
      projectsUpdate.mockResolvedValueOnce({ ...project })

      await expect(
        store.getState().updateProject(project.id, { defaultTuiAgent: 'codex' }, 'local')
      ).resolves.toBe(false)
      expect(store.getState().projects[0]?.defaultTuiAgent).toBeUndefined()

      projectsUpdate.mockResolvedValueOnce({ ...project, defaultTuiAgent: 'codex' })
      await expect(
        store.getState().updateProject(project.id, { defaultTuiAgent: 'codex' }, 'local')
      ).resolves.toBe(true)
      expect(store.getState().projects[0]?.defaultTuiAgent).toBe('codex')
    })

    it('clears a saved project default when the host acknowledges an undefined update', async () => {
      const project: Project = {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#000',
        sourceRepoIds: ['local-repo', 'remote-repo'],
        defaultTuiAgent: 'codex',
        createdAt: 1,
        updatedAt: 1
      }
      const clearedProject = { ...project, sourceRepoIds: ['local-repo'] }
      delete clearedProject.defaultTuiAgent
      projectsUpdate.mockResolvedValue(clearedProject)
      const store = createTestStore()
      store.setState({ projects: [project] })

      await expect(
        store.getState().updateProject(project.id, { defaultTuiAgent: undefined }, 'local')
      ).resolves.toBe(true)
      expect(store.getState().projects[0]).not.toHaveProperty('defaultTuiAgent')
      expect(store.getState().projects[0]?.sourceRepoIds).toEqual(['local-repo', 'remote-repo'])
    })

    it.each(['local', 'ssh:remote'] as const)(
      'preserves the %s caller when local and SSH setups share an endpoint',
      async (hostId) => {
        const repos: Repo[] = [
          { ...localRepo, id: 'a', upstream: { owner: 'acme', repo: 'app' } },
          {
            ...localRepo,
            id: 'b',
            path: '/ssh',
            executionHostId: 'ssh:remote',
            upstream: { owner: 'acme', repo: 'app' }
          }
        ]
        const projection = projectHostSetupProjectionFromRepos(repos)
        const canonicalId = projection.projects[0]!.id
        const localProject = { ...projection.projects[0]!, id: 'repo:a', sourceRepoIds: ['a'] }
        const sshProject = { ...projection.projects[0]!, id: 'repo:b', sourceRepoIds: ['b'] }
        const callerProject = hostId === 'local' ? localProject : sshProject
        const updates = {
          defaultTuiAgent: 'codex' as const,
          localWindowsRuntimePreference: { kind: 'windows-host' as const }
        }
        const store = createTestStore()
        store.setState({
          repos,
          projects: [localProject, sshProject],
          projectHostSetups: projection.setups.map((setup) => ({
            ...setup,
            projectId: setup.repoId === 'a' ? localProject.id : sshProject.id
          }))
        })
        projectsUpdate.mockResolvedValue({ ...callerProject, ...updates })

        await expect(store.getState().updateProject(canonicalId, updates, hostId)).resolves.toBe(
          true
        )
        expect(projectsUpdate).toHaveBeenCalledExactlyOnceWith({
          projectId: callerProject.id,
          updates
        })
        expect(store.getState().projects.find((row) => row.id === callerProject.id)).toMatchObject(
          updates
        )
      }
    )

    it('saves a project default on every known owner host before reporting success', async () => {
      const project: Project = {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#000',
        sourceRepoIds: ['local-repo', 'remote-repo'],
        createdAt: 1,
        updatedAt: 1
      }
      const store = createTestStore()
      store.setState({
        projects: [project],
        projectHostSetups: [
          {
            id: 'local-setup',
            projectId: project.id,
            hostId: 'local',
            repoId: 'local-repo',
            path: '/local',
            displayName: 'Local',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'remote-setup',
            projectId: project.id,
            hostId: 'runtime:env-1',
            repoId: 'remote-repo',
            path: '/remote',
            displayName: 'Remote',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
      projectsUpdate.mockResolvedValue({ ...project, defaultTuiAgent: 'codex' })
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'remote-update',
        ok: true,
        result: { project: { ...project, defaultTuiAgent: 'codex' } }
      })

      await expect(
        store.getState().updateProject(project.id, { defaultTuiAgent: 'codex' }, 'local')
      ).resolves.toBe(true)
      expect(projectsUpdate).toHaveBeenCalledWith({
        projectId: project.id,
        updates: { defaultTuiAgent: 'codex' }
      })
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'env-1',
          method: 'project.update',
          params: { projectId: project.id, updates: { defaultTuiAgent: 'codex' } }
        })
      )
    })

    it('updates every endpoint row when owner hosts use different project IDs', async () => {
      const repos: Repo[] = [
        { ...localRepo, id: 'a', upstream: { owner: 'acme', repo: 'app' } },
        {
          ...localRepo,
          id: 'b',
          path: '/remote',
          executionHostId: 'runtime:env-1',
          upstream: { owner: 'acme', repo: 'app' }
        }
      ]
      const projection = projectHostSetupProjectionFromRepos(repos)
      const canonicalId = projection.projects[0]!.id
      const localProject: Project = {
        ...projection.projects[0]!,
        id: 'repo:a',
        sourceRepoIds: ['a']
      }
      const remoteProject: Project = {
        ...projection.projects[0]!,
        id: 'repo:b',
        sourceRepoIds: ['b'],
        localWindowsRuntimePreference: { kind: 'wsl', distro: 'Ubuntu' }
      }
      const store = createTestStore()
      store.setState({
        repos,
        projects: [localProject, remoteProject],
        projectHostSetups: projection.setups.map((setup) => ({
          ...setup,
          projectId: setup.repoId === 'a' ? localProject.id : remoteProject.id
        }))
      })
      projectsUpdate.mockResolvedValue({
        ...localProject,
        defaultTuiAgent: 'codex',
        localWindowsRuntimePreference: { kind: 'windows-host' }
      })
      runtimeEnvironmentCall.mockResolvedValue({
        id: 'remote-update',
        ok: true,
        result: { project: { ...remoteProject, defaultTuiAgent: 'codex' } }
      })

      await expect(
        store.getState().updateProject(
          canonicalId,
          {
            defaultTuiAgent: 'codex',
            localWindowsRuntimePreference: { kind: 'windows-host' }
          },
          'local'
        )
      ).resolves.toBe(true)
      expect(projectsUpdate).toHaveBeenCalledWith({
        projectId: localProject.id,
        updates: {
          defaultTuiAgent: 'codex',
          localWindowsRuntimePreference: { kind: 'windows-host' }
        }
      })
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'env-1',
          method: 'project.update',
          params: { projectId: remoteProject.id, updates: { defaultTuiAgent: 'codex' } }
        })
      )
      expect(store.getState().projects[1]?.localWindowsRuntimePreference).toEqual({
        kind: 'wsl',
        distro: 'Ubuntu'
      })
      expect(store.getState().projects.map((project) => project.defaultTuiAgent)).toEqual([
        'codex',
        'codex'
      ])
    })

    it('rejects an older owner before updating any project host', async () => {
      const project: Project = {
        id: 'project-1',
        displayName: 'Project',
        badgeColor: '#000',
        sourceRepoIds: ['local-repo', 'remote-repo'],
        createdAt: 1,
        updatedAt: 1
      }
      const store = createTestStore()
      store.setState({
        projects: [project],
        projectHostSetups: [
          {
            id: 'local-setup',
            projectId: project.id,
            hostId: 'local',
            repoId: 'local-repo',
            path: '/local',
            displayName: 'Local',
            setupState: 'ready',
            setupMethod: 'legacy-repo',
            createdAt: 1,
            updatedAt: 1
          },
          {
            id: 'remote-setup',
            projectId: project.id,
            hostId: 'runtime:env-1',
            repoId: 'remote-repo',
            path: '/remote',
            displayName: 'Remote',
            setupState: 'ready',
            setupMethod: 'imported-existing-folder',
            createdAt: 1,
            updatedAt: 1
          }
        ]
      })
      const status = createCompatibleRuntimeStatusResponse()
      if (!status.ok) {
        throw new Error('Invalid test status')
      }
      const olderStatus = { ...status, result: { ...status.result, capabilities: [] } }
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
        args.method === 'status.get' ? olderStatus : runtimeEnvironmentCall(args)
      )

      await expect(
        store.getState().updateProject(project.id, { defaultTuiAgent: 'codex' }, 'local')
      ).resolves.toBe(false)
      expect(projectsUpdate).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    })

    it('reconciles acknowledged rows while reporting a partial cross-host save', async () => {
      const repos: Repo[] = [
        { ...localRepo, id: 'a', upstream: { owner: 'acme', repo: 'app' } },
        {
          ...localRepo,
          id: 'b',
          path: '/remote',
          executionHostId: 'runtime:env-1',
          upstream: { owner: 'acme', repo: 'app' }
        }
      ]
      const projection = projectHostSetupProjectionFromRepos(repos)
      const canonicalId = projection.projects[0]!.id
      const localProject: Project = {
        ...projection.projects[0]!,
        id: 'repo:a',
        sourceRepoIds: ['a'],
        defaultTuiAgent: 'claude'
      }
      const remoteProject: Project = {
        ...projection.projects[0]!,
        id: 'repo:b',
        displayName: 'Remote project',
        sourceRepoIds: ['b'],
        defaultTuiAgent: 'blank'
      }
      const store = createTestStore()
      store.setState({
        repos,
        projects: [localProject, remoteProject],
        projectHostSetups: projection.setups.map((setup) => ({
          ...setup,
          projectId: setup.repoId === 'a' ? localProject.id : remoteProject.id
        }))
      })
      const savedProject = {
        ...localProject,
        defaultTuiAgent: 'codex' as const,
        localWindowsRuntimePreference: { kind: 'windows-host' as const }
      }
      projectsUpdate.mockResolvedValue(savedProject)
      runtimeEnvironmentCall.mockRejectedValue(new Error('Remote disconnected'))
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(
          store.getState().updateProject(
            canonicalId,
            {
              defaultTuiAgent: 'codex',
              localWindowsRuntimePreference: { kind: 'windows-host' }
            },
            'local'
          )
        ).rejects.toThrow('some hosts but not others')
      } finally {
        consoleError.mockRestore()
      }
      expect(store.getState().projects).toEqual([savedProject, remoteProject])
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'project.update',
          params: { projectId: remoteProject.id, updates: { defaultTuiAgent: 'codex' } }
        })
      )
    })
  })
}
