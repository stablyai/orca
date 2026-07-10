import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/types'
import { PROJECT_HOST_SETUP_RUNTIME_CAPABILITY } from '../../../../shared/protocol-version'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import type { RuntimeEnvironmentCallRequest } from '../../runtime/runtime-compatibility-test-fixture'
import { createTestStore } from './store-test-helpers'

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const reposList = vi.fn()
const reposClone = vi.fn()
const reposCloneRemote = vi.fn()
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
  reposCloneRemote.mockReset()
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
        clone: reposClone,
        cloneRemote: reposCloneRemote
      },
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice project-host setup runtime capability', () => {
  it('falls back to repo-derived project setup state when a remote runtime lacks support', async () => {
    runtimeEnvironmentCall.mockResolvedValue({
      id: 'rpc-1',
      ok: true,
      result: { repos: [remoteRepo] },
      _meta: { runtimeId: 'runtime-remote' }
    })
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as never })

    await store.getState().fetchRepos()

    expect(store.getState().projectHostSetups).toEqual([
      expect.objectContaining({ id: 'remote-repo', hostId: 'runtime:env-1' })
    ])
    expect(runtimeEnvironmentCall).toHaveBeenCalledTimes(1)
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.list',
      params: undefined,
      timeoutMs: 15_000
    })
  })

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
