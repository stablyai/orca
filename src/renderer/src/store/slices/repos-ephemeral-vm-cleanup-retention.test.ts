import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { getRepoExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import {
  ephemeralVmCleanup,
  ephemeralVmListRuntimes,
  installReposRuntimeRoutingHarness,
  reposRemoveForHost,
  runtimeEnvironmentCall,
  runtimeEnvironmentsList,
  sshRepo
} from './repos-runtime-routing-fixture'
import { createTestStore } from './store-test-helpers'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn()
  }
}))

installReposRuntimeRoutingHarness()

it('retains a runtime-owned SSH project when VM cleanup fails', async () => {
  const runtimeRepo: Repo = { ...sshRepo, connectionId: 'runtime-ssh-runtime-1' }
  ephemeralVmListRuntimes.mockResolvedValue([
    {
      id: 'runtime-1',
      cleanupStatus: 'not_started',
      sshTargetId: runtimeRepo.connectionId
    }
  ])
  ephemeralVmCleanup.mockResolvedValue({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    sshTargetId: runtimeRepo.connectionId
  })
  const store = createTestStore()
  store.setState({ repos: [runtimeRepo], activeRepoId: runtimeRepo.id })

  await store.getState().removeProject(runtimeRepo.id, {
    hostId: getRepoExecutionHostId(runtimeRepo),
    errorFeedback: 'toast'
  })

  expect(store.getState().repos).toEqual([runtimeRepo])
  expect(reposRemoveForHost).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ description: expect.stringContaining('Retry cleanup') })
  )
})

const vmServerRepo: Repo = {
  ...sshRepo,
  id: 'vm-repo',
  connectionId: null,
  executionHostId: 'runtime:env-vm'
}
const vmServer: PublicKnownRuntimeEnvironment = {
  id: 'env-vm',
  name: 'Docker root VM',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: null,
  runtimeId: null,
  endpoints: [
    { id: 'ws', kind: 'websocket', label: 'WebSocket', endpoint: 'ws://127.0.0.1:41000' }
  ],
  preferredEndpointId: 'ws',
  orcadDeployment: {
    sshTargetId: 'runtime-ssh-runtime-1',
    sshTargetGeneration: 1,
    localPort: 41_000,
    remotePort: 6768
  }
}

it('destroys a recipe VM whose managed server holds the project, without asking the gone server', async () => {
  ephemeralVmListRuntimes.mockResolvedValue([
    { id: 'runtime-1', cleanupStatus: 'not_started', sshTargetId: 'runtime-ssh-runtime-1' }
  ])
  ephemeralVmCleanup.mockResolvedValue({ status: 'cleaned', cleanupStatus: 'succeeded' })
  const store = createTestStore()
  store.setState({
    repos: [vmServerRepo],
    runtimeEnvironments: [vmServer]
  })

  await store.getState().removeProject(vmServerRepo.id, {
    hostId: 'runtime:env-vm',
    errorFeedback: 'toast'
  })

  expect(ephemeralVmCleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
  expect(runtimeEnvironmentCall).not.toHaveBeenCalledWith(
    expect.objectContaining({ method: 'repo.rm' })
  )
  expect(store.getState().repos).toEqual([])
})

it("retains a recipe VM's managed-server project when VM cleanup fails", async () => {
  ephemeralVmListRuntimes.mockResolvedValue([
    { id: 'runtime-1', cleanupStatus: 'not_started', sshTargetId: 'runtime-ssh-runtime-1' }
  ])
  ephemeralVmCleanup.mockResolvedValue({
    status: 'cleanup_failed',
    cleanupStatus: 'failed',
    sshTargetId: 'runtime-ssh-runtime-1'
  })
  const store = createTestStore()
  store.setState({ repos: [vmServerRepo], runtimeEnvironments: [vmServer] })

  await store.getState().removeProject(vmServerRepo.id, {
    hostId: 'runtime:env-vm',
    errorFeedback: 'toast'
  })

  expect(store.getState().repos).toEqual([vmServerRepo])
})

it('never destroys another VM whose server publishes the same workspace id', async () => {
  const sharedWorkspaceId = `${vmServerRepo.id}::/home/orca/project`
  ephemeralVmListRuntimes.mockResolvedValue([
    {
      id: 'runtime-1',
      cleanupStatus: 'not_started',
      sshTargetId: 'runtime-ssh-runtime-1',
      runtimeEnvironmentId: 'env-vm',
      workspaceId: sharedWorkspaceId
    },
    {
      id: 'runtime-2',
      cleanupStatus: 'not_started',
      sshTargetId: 'runtime-ssh-runtime-2',
      runtimeEnvironmentId: 'env-vm-2',
      workspaceId: sharedWorkspaceId
    }
  ])
  ephemeralVmCleanup.mockResolvedValue({ status: 'cleaned', cleanupStatus: 'succeeded' })
  const store = createTestStore()
  store.setState({
    repos: [vmServerRepo],
    runtimeEnvironments: [vmServer],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removal reads only each row's id and hostId.
    worktreesByRepo: {
      [vmServerRepo.id]: [
        {
          id: sharedWorkspaceId,
          repoId: vmServerRepo.id,
          path: '/home/orca/project',
          hostId: 'runtime:env-vm'
        }
      ]
    } as never
  })

  await store.getState().removeProject(vmServerRepo.id, {
    hostId: 'runtime:env-vm',
    errorFeedback: 'toast'
  })

  expect(ephemeralVmCleanup).toHaveBeenCalledTimes(1)
  expect(ephemeralVmCleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
})

it("destroys the VM when the renderer's catalog predates the VM's server", async () => {
  runtimeEnvironmentsList.mockResolvedValue([vmServer])
  ephemeralVmListRuntimes.mockResolvedValue([
    { id: 'runtime-1', cleanupStatus: 'not_started', sshTargetId: 'runtime-ssh-runtime-1' }
  ])
  ephemeralVmCleanup.mockResolvedValue({ status: 'cleaned', cleanupStatus: 'succeeded' })
  const store = createTestStore()
  store.setState({
    repos: [vmServerRepo],
    runtimeEnvironments: [],
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: removal reads only id, hostId and ephemeralVmCheckoutMode.
    worktreesByRepo: {
      [vmServerRepo.id]: [
        {
          id: `${vmServerRepo.id}::/home/orca/project`,
          hostId: 'runtime:env-vm',
          ephemeralVmCheckoutMode: 'provisioned-root'
        }
      ]
    } as never
  })

  await store.getState().removeProject(vmServerRepo.id, {
    hostId: 'runtime:env-vm',
    errorFeedback: 'toast'
  })

  expect(ephemeralVmCleanup).toHaveBeenCalledWith({ runtimeId: 'runtime-1' })
  expect(store.getState().repos).toEqual([])
})
