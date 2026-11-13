import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../testing/app-store-test-fixture'
import { getProjectIdentityKey } from '../../../../shared/project-host-setup-projection'
import { PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY } from '../../../../shared/agent-launch/contracts/agent-launch-runtime-capability'

describe('repos-project-host-lifecycle', () => {
  const projectsCreateHostSetup = vi.fn()
  const projectsUpdateHostSetup = vi.fn()
  const projectsDeleteHostSetup = vi.fn()
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()

  const project: Project = {
    id: 'project-1',
    displayName: 'Project',
    badgeColor: '#000',
    sourceRepoIds: ['local-repo'],
    createdAt: 1,
    updatedAt: 1
  }

  const runtimeRepo: Repo = {
    id: 'runtime-repo',
    path: '/srv/project',
    displayName: 'Project',
    badgeColor: '#111',
    addedAt: 1,
    executionHostId: 'runtime:env-1'
  }

  const runtimeSetup: ProjectHostSetup = {
    id: 'setup-gpu',
    projectId: project.id,
    hostId: 'runtime:env-1',
    repoId: '',
    path: '/srv/project',
    displayName: 'GPU VM',
    setupState: 'ready',
    setupMethod: 'provisioned',
    createdAt: 1,
    updatedAt: 1
  }

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    projectsCreateHostSetup.mockReset()
    projectsUpdateHostSetup.mockReset()
    projectsDeleteHostSetup.mockReset()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: {
          list: vi.fn()
        },
        projects: {
          createHostSetup: projectsCreateHostSetup,
          updateHostSetup: projectsUpdateHostSetup,
          deleteHostSetup: projectsDeleteHostSetup
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })

  describe('repo slice project host setup lifecycle', () => {
    it.each([
      { supported: true, defaultTuiAgent: 'codex' as const },
      { supported: false, defaultTuiAgent: 'codex' as const },
      { supported: true, defaultTuiAgent: null },
      { supported: false, defaultTuiAgent: null }
    ])(
      'preserves a canonical project default $defaultTuiAgent when target support is $supported',
      async ({ supported, defaultTuiAgent }) => {
        const repo: Repo = {
          ...runtimeRepo,
          id: 'local-repo',
          executionHostId: 'local',
          upstream: { owner: 'acme', repo: 'app' }
        }
        const canonicalId = getProjectIdentityKey(repo)
        const sourceProject = {
          ...project,
          id: 'repo:local-repo',
          defaultTuiAgent
        }
        const store = createTestStore()
        store.setState({
          repos: [repo],
          projects: [sourceProject],
          projectHostSetups: [
            {
              ...runtimeSetup,
              id: 'local-setup',
              projectId: sourceProject.id,
              hostId: 'local',
              repoId: repo.id
            }
          ]
        })
        const status = createCompatibleRuntimeStatusResponse()
        if (!status.ok) {
          throw new Error('Invalid test status')
        }
        const capabilities = status.result.capabilities
        if (!capabilities) {
          throw new Error('Missing test capabilities')
        }
        runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
          args.method === 'status.get'
            ? {
                ...status,
                result: {
                  ...status.result,
                  capabilities: capabilities.filter(
                    (capability) =>
                      supported || capability !== PROJECT_DEFAULT_AGENT_RUNTIME_CAPABILITY
                  )
                }
              }
            : runtimeEnvironmentCall(args)
        )
        runtimeEnvironmentCall.mockResolvedValue({
          id: 'create',
          ok: true,
          result: {
            result: {
              project: { ...sourceProject, id: canonicalId },
              setup: { ...runtimeSetup, projectId: canonicalId }
            }
          }
        })
        const result = await store
          .getState()
          .createProjectHostSetup({ projectId: canonicalId, hostId: 'runtime:env-1' })
        if (supported) {
          expect(result?.project.defaultTuiAgent).toBe(defaultTuiAgent)
          expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
            expect.objectContaining({
              method: 'projectHostSetup.create',
              params: { projectId: canonicalId, hostId: 'runtime:env-1', defaultTuiAgent }
            })
          )
        } else {
          expect(result).toBeNull()
          expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
        }
      }
    )

    it('copies a configured project agent default to a newly added host setup', async () => {
      const sourceProject = { ...project, defaultTuiAgent: 'codex' as const }
      const store = createTestStore()
      store.setState({
        projects: [sourceProject],
        projectHostSetups: [
          { ...runtimeSetup, id: 'local-setup', hostId: 'local', repoId: 'local-repo' }
        ]
      })
      runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
        if (args.method === 'projectHostSetup.create') {
          return {
            id: 'create',
            ok: true,
            result: { result: { project: sourceProject, setup: runtimeSetup } }
          }
        }
        throw new Error(`Unexpected method ${args.method}`)
      })

      const result = await store
        .getState()
        .createProjectHostSetup({ projectId: project.id, hostId: 'runtime:env-1' })
      expect(result?.project.defaultTuiAgent).toBe('codex')
      expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
        expect.objectContaining({
          selector: 'env-1',
          method: 'projectHostSetup.create',
          params: { projectId: project.id, hostId: 'runtime:env-1', defaultTuiAgent: 'codex' }
        })
      )
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    })

    it.each(['create', 'existing-folder'] as const)(
      'sends and confirms an explicit inherited default for %s setups',
      async (method) => {
        const sourceProject = { ...project, defaultTuiAgent: null }
        const store = createTestStore()
        store.setState({ projects: [sourceProject] })
        let persistedProject: Project = { ...project, defaultTuiAgent: 'claude' }
        runtimeEnvironmentCall.mockImplementation(async (args: RuntimeEnvironmentCallRequest) => {
          const params = args.params
          if (
            typeof params === 'object' &&
            params !== null &&
            'defaultTuiAgent' in params &&
            params.defaultTuiAgent === null
          ) {
            persistedProject = { ...persistedProject, defaultTuiAgent: null }
          }
          return {
            id: 'setup',
            ok: true,
            result: {
              result: { project: persistedProject, setup: runtimeSetup, repo: runtimeRepo }
            }
          }
        })
        const result =
          method === 'create'
            ? await store
                .getState()
                .createProjectHostSetup({ projectId: project.id, hostId: 'runtime:env-1' })
            : await store.getState().setupProjectExistingFolder({
                projectId: project.id,
                hostId: 'runtime:env-1',
                path: runtimeRepo.path,
                kind: 'git'
              })
        expect(result?.project.defaultTuiAgent).toBeNull()
        expect(store.getState().projects[0]?.defaultTuiAgent).toBeNull()
      }
    )

    it.each(['codex', null] as const)(
      'does not adopt a setup when the host omits requested default %s',
      async (defaultTuiAgent) => {
        const store = createTestStore()
        store.setState({ projects: [{ ...project, defaultTuiAgent }] })
        runtimeEnvironmentCall.mockResolvedValue({
          id: 'create',
          ok: true,
          result: { result: { project, setup: runtimeSetup } }
        })

        await expect(
          store
            .getState()
            .createProjectHostSetup({ projectId: project.id, hostId: 'runtime:env-1' })
        ).resolves.toBeNull()
        expect(store.getState().projectHostSetups).toEqual([])
        expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
      }
    )

    it('does not retry a timed-out setup create request with a project default', async () => {
      const store = createTestStore()
      store.setState({ projects: [{ ...project, defaultTuiAgent: 'codex' }] })
      runtimeEnvironmentCall.mockRejectedValue(new Error('request timed out'))

      await expect(
        store.getState().createProjectHostSetup({ projectId: project.id, hostId: 'runtime:env-1' })
      ).resolves.toBeNull()
      expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
      expect(store.getState().projectHostSetups).toEqual([])
    })

    it('rejects an old target host before creating a setup with a configured project default', async () => {
      const sourceProject = { ...project, defaultTuiAgent: 'codex' as const }
      const store = createTestStore()
      store.setState({
        projects: [sourceProject],
        projectHostSetups: [
          { ...runtimeSetup, id: 'local-setup', hostId: 'local', repoId: 'local-repo' }
        ]
      })
      const status = createCompatibleRuntimeStatusResponse()
      if (!status.ok) {
        throw new Error('Invalid test status')
      }
      const oldStatus = { ...status, result: { ...status.result, capabilities: [] } }
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
        args.method === 'status.get' ? oldStatus : runtimeEnvironmentCall(args)
      )

      await expect(
        store.getState().createProjectHostSetup({ projectId: project.id, hostId: 'runtime:env-1' })
      ).resolves.toBeNull()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      expect(projectsCreateHostSetup).not.toHaveBeenCalled()
    })

    it('rejects an old target host before cloning a configured project', async () => {
      const store = createTestStore()
      store.setState({
        projects: [{ ...project, defaultTuiAgent: 'codex' }],
        projectHostSetups: [
          { ...runtimeSetup, id: 'local-setup', hostId: 'local', repoId: 'local-repo' }
        ]
      })
      const status = createCompatibleRuntimeStatusResponse()
      if (!status.ok) {
        throw new Error('Invalid test status')
      }
      const oldStatus = { ...status, result: { ...status.result, capabilities: [] } }
      runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
        args.method === 'status.get' ? oldStatus : runtimeEnvironmentCall(args)
      )

      await expect(
        store.getState().setupProjectClone({
          projectId: project.id,
          hostId: 'runtime:env-1',
          url: 'https://example.test/repo.git',
          destination: '/remote/repo'
        })
      ).resolves.toBeNull()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    })

    it('refuses an unqualified setup id two hosts share instead of acting on the first', async () => {
      const localSetup: ProjectHostSetup = { ...runtimeSetup, hostId: 'local' }
      const store = createTestStore()
      store.setState({
        projects: [project],
        projectHostSetups: [localSetup, runtimeSetup],
        settings: { activeRuntimeEnvironmentId: null } as never
      })

      await expect(
        store.getState().deleteProjectHostSetup({ setupId: localSetup.id })
      ).resolves.toBeNull()
      await expect(
        store.getState().updateProjectHostSetup({
          setupId: localSetup.id,
          updates: { displayName: 'Renamed' }
        })
      ).resolves.toBeNull()

      expect(projectsDeleteHostSetup).not.toHaveBeenCalled()
      expect(projectsUpdateHostSetup).not.toHaveBeenCalled()
      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
      expect(store.getState().projectHostSetups).toEqual([localSetup, runtimeSetup])
    })

    it('refuses a named host the catalog has no setup for instead of deleting by id', async () => {
      const localSetup: ProjectHostSetup = { ...runtimeSetup, hostId: 'local' }
      const store = createTestStore()
      store.setState({
        projects: [project],
        projectHostSetups: [localSetup],
        settings: { activeRuntimeEnvironmentId: null } as never
      })

      await expect(
        store.getState().deleteProjectHostSetup({ setupId: localSetup.id, hostId: 'ssh:gone' })
      ).resolves.toBeNull()

      expect(projectsDeleteHostSetup).not.toHaveBeenCalled()
      expect(store.getState().projectHostSetups).toEqual([localSetup])
    })
  })
})
