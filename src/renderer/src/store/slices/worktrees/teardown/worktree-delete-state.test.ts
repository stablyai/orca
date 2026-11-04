import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../../worktrees-slice-test-harness'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import { getDeleteStateForWorktreeHost } from '../../../../components/sidebar/workspace-actions/deletion/worktree-delete-state-host-match'

vi.mock('sonner', () => ({
  toast: { warning: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() }
}))
vi.mock('@/components/worktree-base-fallback-notice', () => ({
  requestWorktreeBaseFallbackNotice: vi.fn()
}))

beforeEach(() => {
  resetWorktreeSliceModuleMemory()
  resetRemoteRuntimeMocks()
})

const ID = 'repo1::/path/wt'

describe('worktree delete-state keying', () => {
  it('shows a local-qualified removal failure on the card of a row stored without a host', async () => {
    const store = createTestStore()
    const card = makeWorktree({ id: ID, repoId: 'repo1', path: '/path/wt' })
    store.setState({ worktreesByRepo: { repo1: [card] } })
    mockApi.worktrees.remove.mockRejectedValueOnce(new Error('delete failed'))

    const result = await store.getState().removeWorktree({ id: ID, executionHostId: 'local' })

    expect(result).toMatchObject({ ok: false })
    expect(
      getDeleteStateForWorktreeHost(card, store.getState().deleteStateByWorktreeId)
    ).toMatchObject({ isDeleting: false, error: 'delete failed' })
  })
})
