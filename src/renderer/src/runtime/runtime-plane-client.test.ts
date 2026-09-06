import { beforeEach, describe, expect, it, vi } from 'vitest'

const { callRuntimeRpcMock, supportsCapabilityMock, planeApi } = vi.hoisted(() => ({
  callRuntimeRpcMock: vi.fn(),
  supportsCapabilityMock: vi.fn(),
  planeApi: {
    status: vi.fn(),
    connect: vi.fn(),
    listProjects: vi.fn(),
    listWorkItems: vi.fn(),
    cancelSearchWorkItems: vi.fn()
  }
}))

const REMOTE = { activeRuntimeEnvironmentId: 'env-1' }
const LOCAL = { activeRuntimeEnvironmentId: null }

async function loadClient(target: 'local' | 'environment') {
  vi.resetModules()
  vi.doMock('./runtime-rpc-client', () => ({
    callRuntimeRpc: callRuntimeRpcMock,
    runtimeEnvironmentSupportsCapability: supportsCapabilityMock,
    getActiveRuntimeTarget: () =>
      target === 'environment' ? { kind: 'environment', environmentId: 'env-1' } : { kind: 'local' }
  }))
  return import('./runtime-plane-client')
}

beforeEach(() => {
  callRuntimeRpcMock.mockReset()
  supportsCapabilityMock.mockReset()
  for (const mock of Object.values(planeApi)) {
    mock.mockReset()
    mock.mockResolvedValue(undefined)
  }
  supportsCapabilityMock.mockResolvedValue(true)
  callRuntimeRpcMock.mockResolvedValue(undefined)
  ;(globalThis as { window?: unknown }).window = { api: { plane: planeApi } }
})

describe('local target', () => {
  it('goes through the preload bridge and never checks capabilities', async () => {
    const client = await loadClient('local')
    await client.planeStatus(LOCAL)
    expect(planeApi.status).toHaveBeenCalledTimes(1)
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
    expect(supportsCapabilityMock).not.toHaveBeenCalled()
  })

  it('cancels a local search through the bridge', async () => {
    const client = await loadClient('local')
    await client.planeCancelSearchWorkItems(LOCAL, 'req-1')
    expect(planeApi.cancelSearchWorkItems).toHaveBeenCalledWith({ requestId: 'req-1' })
  })
})

describe('remote target', () => {
  it('gates every call on the plane.provider.v1 capability', async () => {
    const client = await loadClient('environment')
    await client.planeListProjects(REMOTE)
    expect(supportsCapabilityMock).toHaveBeenCalledWith('env-1', 'plane.provider.v1', 30_000)
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      { kind: 'environment', environmentId: 'env-1' },
      'plane.listProjects',
      undefined,
      { timeoutMs: 30_000 }
    )
    expect(planeApi.listProjects).not.toHaveBeenCalled()
  })

  it('explains an older server instead of failing with method_not_found', async () => {
    supportsCapabilityMock.mockResolvedValue(false)
    const client = await loadClient('environment')
    await expect(client.planeStatus(REMOTE)).rejects.toBeInstanceOf(
      client.PlaneProviderUnsupportedError
    )
    // The call must not be attempted: an unsupported host would report a
    // method_not_found that reads like a Plane outage.
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('refuses a write on an unsupported server before it reaches the wire', async () => {
    supportsCapabilityMock.mockResolvedValue(false)
    const client = await loadClient('environment')
    await expect(
      client.planeAddComment(REMOTE, {
        project: { id: 'p-1', identifier: 'PROJ', name: 'Platform' },
        workItemId: 'wi-1',
        body: 'hello'
      })
    ).rejects.toThrow('does not support Plane yet')
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('treats search cancellation as a no-op, since the host owns the socket', async () => {
    const client = await loadClient('environment')
    await client.planeCancelSearchWorkItems(REMOTE, 'req-1')
    expect(planeApi.cancelSearchWorkItems).not.toHaveBeenCalled()
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('forwards args unchanged to the matching rpc method', async () => {
    const client = await loadClient('environment')
    const args = { projectId: 'p-1', workspaceId: 'ws-1' }
    await client.planeListStates(REMOTE, args)
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'environment' }),
      'plane.listStates',
      args,
      { timeoutMs: 30_000 }
    )
  })
})
