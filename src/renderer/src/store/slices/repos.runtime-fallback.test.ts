import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from './store-test-helpers'
import type { Repo } from '../../../../shared/types'
import {
  FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY,
  RUNTIME_CAPABILITIES
} from '../../../../shared/protocol-version'
import {
  createCompatibleRuntimeStatusResponse,
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'

const toastError = vi.hoisted(() => vi.fn())
const toastInfo = vi.hoisted(() => vi.fn())
const toastSuccess = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    error: toastError,
    info: toastInfo,
    success: toastSuccess
  }
}))

const remoteRepo: Repo = {
  id: 'remote-repo',
  path: '/remote',
  displayName: 'Remote',
  badgeColor: '#111',
  addedAt: 2
}

const runtimeEnvironmentCall = vi.fn()
const runtimeEnvironmentTransportCall = vi.fn()

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  runtimeEnvironmentCall.mockReset()
  runtimeEnvironmentTransportCall.mockReset()
  toastError.mockReset()
  toastInfo.mockReset()
  toastSuccess.mockReset()
  runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
    return createCompatibleRuntimeStatusResponseIfNeeded(args) ?? runtimeEnvironmentCall(args)
  })
  vi.stubGlobal('window', {
    api: {
      runtimeEnvironments: { call: runtimeEnvironmentTransportCall }
    }
  })
})

describe('repo slice runtime folder fallback', () => {
  it('blocks wrong-host runtime fallback', async () => {
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      const { method } = request
      if (method === 'repo.add') {
        return {
          id: 'rpc-add-git',
          ok: false,
          error: { code: 'repo.invalid', message: 'Not a valid git repository' },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (method === 'folderWorkspace.getPathStatus') {
        return {
          id: 'rpc-path-status',
          ok: true,
          result: {
            status: {
              path: '/Users/me/GitHub/travel-hub',
              exists: false,
              reason: 'missing'
            }
          },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (method === 'projectGroup.delete') {
        return {
          id: 'rpc-delete-status-scope',
          ok: true,
          result: { deleted: true },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      runtimeEnvironments: [{ id: 'env-1', name: 'Remote Mac' }] as never
    })

    await expect(
      store.getState().addRepoPath('/Users/me/GitHub/travel-hub', 'git')
    ).resolves.toBeNull()

    expect(store.getState().activeModal).not.toBe('confirm-non-git-folder')
    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'folderWorkspace.getPathStatus',
      params: { scope: 'path', path: '/Users/me/GitHub/travel-hub' },
      timeoutMs: 15_000
    })
    expect(toastError).toHaveBeenCalledWith(
      'Cannot open folder on selected runtime',
      expect.objectContaining({
        description: expect.stringContaining('Remote Mac')
      })
    )
  })

  it('treats runtime status RPC failures as host-scoped errors', async () => {
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      const { method } = request
      if (method === 'repo.add') {
        return {
          id: 'rpc-add-git',
          ok: false,
          error: { code: 'repo.invalid', message: 'Not a valid git repository' },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (method === 'folderWorkspace.getPathStatus') {
        throw new Error('status unavailable')
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      runtimeEnvironments: [{ id: 'env-1', name: 'Remote Mac' }] as never
    })

    await expect(
      store.getState().addRepoPath('/Users/me/GitHub/travel-hub', 'git')
    ).resolves.toBeNull()

    expect(store.getState().activeModal).not.toBe('confirm-non-git-folder')
    expect(toastError).toHaveBeenCalledWith(
      'Cannot open folder on selected runtime',
      expect.objectContaining({
        description: expect.stringContaining('Remote Mac')
      })
    )
  })

  it('reports an update error when the checked runtime lacks raw path status support', async () => {
    runtimeEnvironmentTransportCall.mockImplementation((args: RuntimeEnvironmentCallRequest) => {
      if (args.method === 'status.get') {
        const response = createCompatibleRuntimeStatusResponse()
        if (!response.ok) {
          throw new Error('Expected compatible runtime status fixture')
        }
        return {
          ...response,
          result: {
            ...response.result,
            capabilities: RUNTIME_CAPABILITIES.filter(
              (capability) => capability !== FOLDER_WORKSPACE_PATH_STATUS_RUNTIME_CAPABILITY
            )
          }
        }
      }
      return runtimeEnvironmentCall(args)
    })
    runtimeEnvironmentCall.mockImplementation((request: RuntimeEnvironmentCallRequest) => {
      const { method } = request
      if (method === 'repo.add') {
        return {
          id: 'rpc-add-git',
          ok: false,
          error: { code: 'repo.invalid', message: 'Not a valid git repository' },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      runtimeEnvironments: [{ id: 'env-1', name: 'Remote Mac' }] as never
    })

    await expect(store.getState().addRepoPath('/srv/non-git', 'git')).resolves.toBeNull()

    expect(store.getState().activeModal).not.toBe('confirm-non-git-folder')
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'folderWorkspace.getPathStatus'
      })
    )
    expect(toastError).toHaveBeenCalledWith(
      'Failed to add project',
      expect.objectContaining({
        description: 'Update Orca server to open non-Git folders on this runtime.'
      })
    )
  })

  it('keeps runtime folder fallback on the checked host', async () => {
    const folderRepo: Repo = {
      ...remoteRepo,
      id: 'runtime-folder',
      path: '/srv/non-git',
      displayName: 'non-git',
      kind: 'folder'
    }
    runtimeEnvironmentCall.mockImplementation((request) => {
      const { selector, method, params } = request as {
        selector: string
        method: string
        params?: unknown
      }
      if (method === 'repo.add' && (params as { kind?: string }).kind === 'git') {
        return {
          id: 'rpc-add-git',
          ok: false,
          error: { code: 'repo.invalid', message: 'Not a valid git repository' },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      if (method === 'repo.add' && (params as { kind?: string }).kind === 'folder') {
        return {
          id: 'rpc-add-folder',
          ok: true,
          result: { repo: folderRepo },
          _meta: { runtimeId: `runtime-${selector}` }
        }
      }
      if (method === 'folderWorkspace.getPathStatus') {
        return {
          id: 'rpc-path-status',
          ok: true,
          result: {
            status: {
              path: '/srv/non-git',
              exists: true
            }
          },
          _meta: { runtimeId: 'runtime-remote' }
        }
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    const store = createTestStore()
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
      fetchWorktrees: vi.fn().mockResolvedValue(undefined) as never
    })

    await expect(store.getState().addRepoPath('/srv/non-git', 'git')).resolves.toBeNull()

    expect(store.getState().activeModal).toBe('confirm-non-git-folder')
    expect(store.getState().modalData).toEqual({
      folderPath: '/srv/non-git',
      runtimeEnvironmentId: 'env-1'
    })

    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-2' } as never })
    await expect(
      store.getState().addNonGitFolder('/srv/non-git', { runtimeEnvironmentId: 'env-1' })
    ).resolves.toEqual({ ...folderRepo, executionHostId: 'runtime:env-1' })

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith({
      selector: 'env-1',
      method: 'repo.add',
      params: { path: '/srv/non-git', kind: 'folder' },
      timeoutMs: 15_000
    })
    expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'env-2',
        method: 'repo.add',
        params: { path: '/srv/non-git', kind: 'folder' }
      })
    )
  })
})
