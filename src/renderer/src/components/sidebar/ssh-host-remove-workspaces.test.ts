/**
 * A `forget-local` host clear is defined as touching nothing outside this client. The repo loop
 * used to drop the mode, so `removeProject` fell back to its default delete-on-host behaviour:
 * for a repo whose owner is a runtime-owned SSH target that means destroying the project's
 * ephemeral VM, and for a runtime-owned project it means dispatching `repo.rm` to a host the user
 * asked not to contact (docs/reference/ssh-execution-boundary.md).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { createTestStore } from '@/store/slices/store-test-helpers'
import type { Repo } from '../../../../shared/repo-types'
import {
  createCompatibleRuntimeStatusResponseIfNeeded,
  type RuntimeEnvironmentCallRequest
} from '../../runtime/runtime-compatibility-test-fixture'
import { clearRuntimeCompatibilityCacheForTests } from '../../runtime/runtime-rpc-client'
import { clearSshHostWorkspaces } from './ssh-host-remove-workspaces'
import type { SshHostRemoveResolution } from './ssh-host-remove-resolution'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() } }))

const cleanupEphemeralVmRuntimesForDeleted = vi.fn()
vi.mock('@/lib/ephemeral-vm-runtime-cleanup', () => ({
  cleanupEphemeralVmRuntimesForDeleted: (...args: unknown[]) =>
    cleanupEphemeralVmRuntimesForDeleted(...args)
}))

const storeRef: { current: ReturnType<typeof createTestStore> | null } = { current: null }
vi.mock('@/store', () => ({
  useAppStore: {
    getState: () => storeRef.current?.getState()
  }
}))

const reposRemove = vi.fn()
const reposRemoveForHost = vi.fn()
const runtimeEnvironmentCall = vi.fn<(args: RuntimeEnvironmentCallRequest) => unknown>()

// An ephemeral-VM project: its SSH target is owned by a runtime, so delete-on-host tears the VM down.
const vmRepo: Repo = {
  id: 'project-vm',
  path: '/home/dev/project-vm',
  displayName: 'VM project',
  badgeColor: '#000',
  addedAt: 1,
  connectionId: 'runtime-ssh-env-1',
  executionHostId: 'ssh:runtime-ssh-env-1'
}

function resolutionFor(repoId: string, targetId: string): SshHostRemoveResolution {
  return {
    targetId,
    workspaceWorktreeIds: [],
    hostRepoIds: [repoId],
    workspaceCount: 1,
    isConnected: false
  }
}

beforeEach(() => {
  clearRuntimeCompatibilityCacheForTests()
  for (const mock of [
    reposRemove,
    reposRemoveForHost,
    runtimeEnvironmentCall,
    cleanupEphemeralVmRuntimesForDeleted
  ]) {
    mock.mockReset()
  }
  cleanupEphemeralVmRuntimesForDeleted.mockResolvedValue({ retainedSshTargetIds: [] })
  runtimeEnvironmentCall.mockImplementation(
    (args) =>
      createCompatibleRuntimeStatusResponseIfNeeded(args) ?? {
        id: 'rpc',
        ok: true,
        result: {},
        _meta: { runtimeId: 'runtime-remote' }
      }
  )
  vi.stubGlobal('window', {
    api: {
      repos: { remove: reposRemove, removeForHost: reposRemoveForHost },
      pty: { kill: vi.fn() },
      runtimeEnvironments: { call: runtimeEnvironmentCall },
      ui: { set: vi.fn().mockResolvedValue(undefined) }
    }
  })
  const store = createTestStore()
  store.setState({
    settings: { activeRuntimeEnvironmentId: 'env-1' } as never,
    repos: [vmRepo]
  })
  storeRef.current = store
})

describe('clearSshHostWorkspaces in forget-local mode', () => {
  it('never destroys an ephemeral VM while forgetting a host', async () => {
    const result = await clearSshHostWorkspaces(
      resolutionFor('project-vm', 'runtime-ssh-env-1'),
      'forget-local'
    )

    expect(cleanupEphemeralVmRuntimesForDeleted).not.toHaveBeenCalled()
    // A forget cannot both leave the host untouched and destroy its VM, so the removal refuses
    // and the caller keeps the host rather than losing the VM to an operation that promised not to.
    expect(result.failedIds).toEqual(['project-vm'])
    expect(storeRef.current?.getState().repos.map((repo) => repo.id)).toEqual(['project-vm'])
  })

  it('dispatches no repo.rm to the host being forgotten', async () => {
    storeRef.current?.setState({
      repos: [
        { ...vmRepo, id: 'project-ssh', connectionId: 'host-1', executionHostId: 'ssh:host-1' }
      ]
    })

    const result = await clearSshHostWorkspaces(
      resolutionFor('project-ssh', 'host-1'),
      'forget-local'
    )

    const dispatchedMethods = runtimeEnvironmentCall.mock.calls.map(([args]) => args.method)
    expect(dispatchedMethods).not.toContain('repo.rm')
    expect(result.failedIds).toEqual([])
    // Host-scoped, so a same-id project on another host keeps its own row.
    expect(reposRemoveForHost).toHaveBeenCalledWith({
      repoId: 'project-ssh',
      hostId: 'ssh:host-1'
    })
    expect(reposRemove).not.toHaveBeenCalled()
    expect(storeRef.current?.getState().repos).toEqual([])
  })
})

it('keeps destroying the VM when the host clear is a real delete', async () => {
  await clearSshHostWorkspaces(resolutionFor('project-vm', 'runtime-ssh-env-1'), 'delete-remote')

  expect(cleanupEphemeralVmRuntimesForDeleted).toHaveBeenCalledTimes(1)
  expect(toast.error).not.toHaveBeenCalled()
})
