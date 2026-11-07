import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'

import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { createTestStore } from '../slices/store-test-helpers'

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
