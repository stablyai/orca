import { expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { Repo } from '../../../../shared/repo-types'
import {
  ephemeralVmCleanup,
  ephemeralVmListRuntimes,
  installReposRuntimeRoutingHarness,
  reposRemove,
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

  await store.getState().removeProject(runtimeRepo.id, { errorFeedback: 'toast' })

  expect(store.getState().repos).toEqual([runtimeRepo])
  expect(reposRemove).not.toHaveBeenCalled()
  expect(toast.error).toHaveBeenCalledWith(
    expect.any(String),
    expect.objectContaining({ description: expect.stringContaining('Retry cleanup') })
  )
})
