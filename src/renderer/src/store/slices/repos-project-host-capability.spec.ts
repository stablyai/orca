import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PROJECT_HOST_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { createTestStore } from './store-test-helpers'

export function registerReposProjectHostCapabilityTests(): void {
  const reposList = vi.fn()
  const reposClone = vi.fn()
  const runtimeEnvironmentCall = vi.fn()
  const runtimeEnvironmentTransportCall = vi.fn()
  let runtimeCapabilities: string[] = []

  function runtimeStatusWithoutProjectHostSetup() {
    return {
      id: 'status',
      ok: true,
      result: {
        runtimeId: 'runtime-remote',
        rendererGraphEpoch: 0,
        graphStatus: 'ready',
        authoritativeWindowId: null,
        liveTabCount: 0,
        liveLeafCount: 0,
        runtimeProtocolVersion: 3,
        minCompatibleRuntimeClientVersion: 2,
        capabilities: runtimeCapabilities
      },
      _meta: { runtimeId: 'runtime-remote' }
    }
  }

  beforeEach(() => {
    clearRuntimeCompatibilityCacheForTests()
    reposList.mockReset()
    reposClone.mockReset()
    runtimeEnvironmentCall.mockReset()
    runtimeEnvironmentTransportCall.mockReset()
    runtimeCapabilities = []
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'status.get') {
        return runtimeStatusWithoutProjectHostSetup()
      }
      return runtimeEnvironmentCall(args)
    })
    vi.stubGlobal('window', {
      api: {
        repos: {
          list: reposList,
          clone: reposClone
        },
        runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
      }
    })
  })

  describe('repo slice project-host setup runtime capability', () => {
    it('blocks runtime project setup when the server does not advertise support', async () => {
      const store = createTestStore()

      await expect(
        store.getState().setupProjectExistingFolder({
          projectId: 'project-1',
          hostId: 'runtime:env-1',
          path: '/srv/project',
          kind: 'git'
        })
      ).resolves.toBeNull()

      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    })

    it('blocks runtime project clone before mutating unsupported servers', async () => {
      const store = createTestStore()

      await expect(
        store.getState().setupProjectClone({
          projectId: 'project-1',
          hostId: 'runtime:env-1',
          url: 'https://github.com/stablyai/orca.git',
          destination: '/srv'
        })
      ).resolves.toBeNull()

      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    })

    it('blocks runtime project setup mutations when workspace run-context support is missing', async () => {
      runtimeCapabilities = [PROJECT_HOST_SETUP_RUNTIME_CAPABILITY]
      const store = createTestStore()

      await expect(
        store.getState().setupProjectExistingFolder({
          projectId: 'project-1',
          hostId: 'runtime:env-1',
          path: '/srv/project',
          kind: 'git'
        })
      ).resolves.toBeNull()

      await expect(
        store.getState().setupProjectClone({
          projectId: 'project-1',
          hostId: 'runtime:env-1',
          url: 'https://github.com/stablyai/orca.git',
          destination: '/srv'
        })
      ).resolves.toBeNull()

      expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    })
  })
}
