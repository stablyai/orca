import type { ExecutionHostId } from '../../../../shared/execution-host'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import 'sonner'
import 'react'
import 'react-dom/server'
import '@/components/ui/tooltip'

import '../../../../shared/workspace-scope'
import { TEST_REPO, makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

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

describe('createWorktree base status merge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('does not overwrite a newer reconcile status with the initial checking status', async () => {
    const store = createRepoTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    mockApi.worktrees.create.mockImplementation(async () => {
      store.getState().updateWorktreeBaseStatus({
        repoId: 'repo1',
        worktreeId: wt.id,
        status: 'drift',
        base: 'origin/main',
        remote: 'origin',
        behind: 2,
        recentSubjects: ['new base commit']
      })
      return {
        worktree: wt,
        initialBaseStatus: {
          repoId: 'repo1',
          worktreeId: wt.id,
          status: 'checking',
          base: 'origin/main',
          remote: 'origin'
        }
      }
    })

    await store.getState().createWorktree('repo1', 'feature')

    expect(store.getState().baseStatusByWorktreeId[wt.id]).toMatchObject({
      status: 'drift',
      behind: 2
    })
  })
})

function seedRepoHost(store: ReturnType<typeof createTestStore>, hostId: ExecutionHostId): void {
  store.setState({ repos: [{ ...TEST_REPO, executionHostId: hostId }] })
}

function createRepoTestStore(): ReturnType<typeof createTestStore> {
  const store = createTestStore()
  seedRepoHost(store, 'local')
  return store
}
