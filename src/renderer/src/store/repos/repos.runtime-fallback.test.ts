import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestStore } from '../testing/app-store-test-fixture'
import type { Repo } from '../../../../shared/repo-types'
import '../../../../shared/worktree-runtime-capabilities'
import '../../../../shared/protocol-version'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCache as clearRuntimeCompatibilityCacheForTests } from '../../runtime/rpc/compatibility/runtime-compatibility-cache'
import { stubRuntimeEnvironmentBridge } from '../../runtime/rpc/testing/runtime-environment-bridge-fixture'

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
  stubRuntimeEnvironmentBridge({ call: runtimeEnvironmentTransportCall })
})

describe('repo slice runtime folder fallback', () => {
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
