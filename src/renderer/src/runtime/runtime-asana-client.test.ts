import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  asanaListProjects,
  asanaListTasks,
  asanaSearchTasks,
  asanaStatus,
  asanaUpdateTask
} from './runtime-asana-client'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from './runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from './runtime-rpc-client'

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()
const local = {
  status: vi.fn(),
  searchTasks: vi.fn(),
  listTasks: vi.fn(),
  updateTask: vi.fn(),
  listProjects: vi.fn()
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  Object.values(local).forEach((fn) => fn.mockReset())
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall },
      asana: { ...local }
    }
  })
})

describe('runtime asana client', () => {
  it('uses local Asana IPC when no runtime environment is active', async () => {
    local.status.mockResolvedValue({ connected: false, viewer: null })
    local.listTasks.mockResolvedValue([{ gid: '1' }])
    local.listProjects.mockResolvedValue([{ gid: 'proj-1' }])

    await expect(asanaStatus({ activeRuntimeEnvironmentId: null })).resolves.toEqual({
      connected: false,
      viewer: null
    })
    await expect(
      asanaListTasks({ activeRuntimeEnvironmentId: null }, 'assigned', 30, 'ws-1')
    ).resolves.toEqual([{ gid: '1' }])
    await asanaListProjects({ activeRuntimeEnvironmentId: null }, 'ws-1')

    expect(local.listTasks).toHaveBeenCalledWith({
      filter: 'assigned',
      limit: 30,
      workspaceId: 'ws-1'
    })
    expect(local.listProjects).toHaveBeenCalledWith({ workspaceId: 'ws-1' })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
  })

  it('routes Asana reads and mutations through the selected runtime environment', async () => {
    runtimeEnvironmentCall
      .mockResolvedValueOnce({
        id: 'r1',
        ok: true,
        result: { connected: true, viewer: null },
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'r2',
        ok: true,
        result: [{ gid: '2' }],
        _meta: { runtimeId: 'runtime-1' }
      })
      .mockResolvedValueOnce({
        id: 'r3',
        ok: true,
        result: { ok: true },
        _meta: { runtimeId: 'runtime-1' }
      })

    await asanaStatus({ activeRuntimeEnvironmentId: 'env-1' })
    await asanaSearchTasks({ activeRuntimeEnvironmentId: 'env-1' }, 'login', 30, 'all')
    await asanaUpdateTask({ activeRuntimeEnvironmentId: 'env-1' }, '3', { completed: true }, 'ws-1')

    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(1, {
      selector: 'env-1',
      method: 'asana.status',
      params: undefined,
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(2, {
      selector: 'env-1',
      method: 'asana.searchTasks',
      params: { query: 'login', limit: 30, workspaceId: 'all' },
      timeoutMs: 30_000
    })
    expect(runtimeEnvironmentCall).toHaveBeenNthCalledWith(3, {
      selector: 'env-1',
      method: 'asana.updateTask',
      params: { gid: '3', updates: { completed: true }, workspaceId: 'ws-1' },
      timeoutMs: 30_000
    })
    expect(local.status).not.toHaveBeenCalled()
  })
})
