import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory
} from '../../worktrees-slice-test-harness'
import { makeWorktree } from '../../worktrees-slice-test-fixtures'
import { getDeleteStateForWorktreeHost } from '../../../../components/sidebar/worktree-delete-state-host-match'

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
  it('shows a local-qualified delete on the card of a row stored without a host', () => {
    const store = createTestStore()
    const card = makeWorktree({ id: ID, repoId: 'repo1' })
    store.setState({ worktreesByRepo: { repo1: [card] } })

    store.getState().markWorktreesQueuedForDeletion([{ id: ID, hostId: 'local' }])
    expect(
      getDeleteStateForWorktreeHost(card, store.getState().deleteStateByWorktreeId)
    ).toMatchObject({ isDeleting: true, phase: 'queued' })

    store.getState().markWorktreesDeleting([{ id: ID, hostId: 'local' }])
    expect(
      getDeleteStateForWorktreeHost(card, store.getState().deleteStateByWorktreeId)
    ).toMatchObject({ isDeleting: true, phase: 'deleting' })

    store.getState().clearWorktreeDeleteState(ID, 'local')
    expect(store.getState().deleteStateByWorktreeId).toEqual({})
  })

  it('keeps the same id on two hosts in separate delete states', () => {
    const store = createTestStore()
    const local = makeWorktree({ id: ID, repoId: 'repo1' })
    const remote = makeWorktree({ id: ID, repoId: 'repo1', hostId: 'ssh:host-b' })
    store.setState({ worktreesByRepo: { repo1: [local, remote] } })

    store.getState().markWorktreesQueuedForDeletion([{ id: ID, hostId: 'ssh:host-b' }])
    const states = store.getState().deleteStateByWorktreeId
    expect(getDeleteStateForWorktreeHost(remote, states)?.isDeleting).toBe(true)
    expect(getDeleteStateForWorktreeHost(local, states)).toBeUndefined()

    store.getState().clearWorktreeDeleteState(ID, 'ssh:host-b')
    expect(store.getState().deleteStateByWorktreeId).toEqual({})
  })

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
