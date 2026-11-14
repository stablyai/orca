import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import '../create-worktree-slice'
import { makeDetectedResult, qualifyDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../worktrees-slice-test-harness'

const requestWorktreeBaseFallbackNotice = vi.hoisted(() => vi.fn())

vi.mock('sonner', () => ({
  toast: {
    warning: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn()
  }
}))

vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice
}))

beforeEach(resetWorktreeSliceModuleMemory)

describe('fetchWorktrees', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
    clearHugeRepoWarningDismissalsForTests()
  })

  it('awaits missing-worktree terminal teardown before purging renderer state', async () => {
    const store = createTestStore()
    const deleted = makeWorktree({
      id: 'repo1::/path/deleted',
      repoId: 'repo1',
      path: '/path/deleted'
    })
    const surviving = makeWorktree({
      id: 'repo1::/path/surviving',
      repoId: 'repo1',
      path: '/path/surviving'
    })
    let finishTeardown!: () => void
    mockApi.runtime.call.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishTeardown = () =>
            resolve({
              id: 'teardown',
              ok: true,
              result: { stoppedWorktreeIds: [deleted.id] }
            })
        })
    )
    mockApi.worktrees.listDetected.mockImplementationOnce(async (args) =>
      qualifyDetectedResult(args, makeDetectedResult('repo1', [surviving]))
    )
    store.setState({
      repos: [
        {
          id: 'repo1',
          path: '/path/repo1',
          displayName: 'Repo 1',
          badgeColor: '#000',
          addedAt: 0,
          connectionId: 'ssh-1'
        }
      ],
      worktreesByRepo: { repo1: [deleted, surviving] },
      detectedWorktreesByRepo: {
        repo1: makeDetectedResult('repo1', [deleted, surviving])
      },
      tabsByWorktree: {
        [deleted.id]: [{ id: 'tab-deleted', worktreeId: deleted.id }]
      }
    } as unknown as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(mockApi.runtime.call).toHaveBeenCalledTimes(1))

    expect(mockApi.runtime.call).toHaveBeenCalledWith({
      method: 'worktree.teardownMissingTerminals',
      params: { repo: 'repo1', worktreeIds: [deleted.id], connectionId: 'ssh-1' }
    })
    expect(store.getState().tabsByWorktree[deleted.id]).toBeDefined()

    finishTeardown()
    await refresh

    expect(store.getState().tabsByWorktree[deleted.id]).toBeUndefined()
  })
})
