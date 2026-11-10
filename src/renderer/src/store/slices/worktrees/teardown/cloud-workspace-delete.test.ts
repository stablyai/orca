import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RuntimeEnvironmentCallRequest } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import '../../../../../../shared/constants'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
} from '../worktrees-slice-test-harness'

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

beforeEach(resetWorktreeSliceModuleMemory)

function seedCloudWorkspace() {
  const store = createTestStore()
  const wt = makeWorktree({
    id: 'repo1::/vercel/sandbox/project',
    repoId: 'repo1',
    path: '/vercel/sandbox/project',
    hostId: 'runtime:cloud-env',
    runtimeOwnerEnvironmentId: 'cloud-env'
  })
  store.setState({ worktreesByRepo: { repo1: [wt] } })
  return { store, wt }
}

function calledMethods(): string[] {
  return runtimeEnvironmentCall.mock.calls.map(
    ([call]: [RuntimeEnvironmentCallRequest]) => call.method
  )
}

describe('Orca Cloud workspace delete', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    runtimeEnvironmentCall.mockImplementation((args: RuntimeEnvironmentCallRequest) =>
      Promise.resolve(
        args.method === 'repo.hooksCheck'
          ? {
              id: 'rpc-hooks',
              ok: true,
              result: { hasHooks: false, hooks: null, mayNeedUpdate: false },
              _meta: { runtimeId: 'cloud-runtime' }
            }
          : { id: 'rpc-rm', ok: true, result: {}, _meta: { runtimeId: 'cloud-runtime' } }
      )
    )
  })

  it('keeps the row and destroys nothing when Orca Cloud cannot confirm the sandbox (W9 D-2)', async () => {
    const { store, wt } = seedCloudWorkspace()
    const preflight = vi.fn().mockResolvedValue({
      ok: false,
      error: 'not confirmed',
      errorCode: 'cloudDeleteNotConfirmed'
    })
    Object.assign(mockApi.ephemeralVm, { preflightCloudDelete: preflight })

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

    expect(result.ok).toBe(false)
    expect(preflight).toHaveBeenCalledWith({ runtimeEnvironmentId: 'cloud-env' })
    expect(calledMethods()).not.toContain('worktree.rm')
    expect(mockApi.ephemeralVm.cleanup).not.toHaveBeenCalled()
    expect(store.getState().worktreesByRepo.repo1?.map((entry) => entry.id)).toEqual([wt.id])
  })

  it('deletes an asleep sandbox without waking it: forget the row locally, then destroy', async () => {
    const { store, wt } = seedCloudWorkspace()
    Object.assign(mockApi.ephemeralVm, {
      preflightCloudDelete: vi.fn().mockResolvedValue({ ok: true, asleep: true })
    })
    mockApi.ephemeralVm.listRuntimes.mockImplementation(async () => [
      { id: 'runtime-cloud', workspaceId: wt.id, cleanupStatus: 'not_started' }
    ])

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null }, true)

    expect(result).toEqual({ ok: true })
    // Nothing goes to the asleep sandbox's server, not even the archive-hook check (W9: a 31 s
    // delete was waiting out request timeouts against it).
    expect(calledMethods()).toEqual([])
    expect(mockApi.worktrees.forgetLocal).toHaveBeenCalled()
    expect(mockApi.ephemeralVm.cleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-cloud' })
  })

  it('asks for Force delete before destroying an asleep sandbox it could not check', async () => {
    const { store, wt } = seedCloudWorkspace()
    Object.assign(mockApi.ephemeralVm, {
      preflightCloudDelete: vi.fn().mockResolvedValue({ ok: true, asleep: true })
    })

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

    expect(result.ok).toBe(false)
    expect(mockApi.worktrees.forgetLocal).not.toHaveBeenCalled()
    expect(mockApi.ephemeralVm.cleanup).not.toHaveBeenCalled()
    expect(store.getState().deleteStateByWorktreeId[wt.id]?.canForceDelete).toBe(true)
  })

  it('forgets the row of a sandbox Orca Cloud already destroyed', async () => {
    const { store, wt } = seedCloudWorkspace()
    Object.assign(mockApi.ephemeralVm, {
      preflightCloudDelete: vi.fn().mockResolvedValue({ ok: true, gone: true })
    })

    const result = await store.getState().removeWorktree({ id: wt.id, executionHostId: null })

    expect(result).toEqual({ ok: true })
    expect(calledMethods()).not.toContain('worktree.rm')
    expect(mockApi.worktrees.forgetLocal).toHaveBeenCalled()
  })
})
