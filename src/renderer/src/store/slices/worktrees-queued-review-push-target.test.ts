import { reviewTarget } from '../../../../shared/__fixtures__/git-review-target'
import { beforeEach, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import { makeWorktree } from './worktrees-slice-test-fixtures'
import {
  createTestStore,
  mockApi,
  resetWorktreeSliceModuleMemory
} from './worktrees-slice-test-harness'

beforeEach(() => {
  vi.clearAllMocks()
  resetWorktreeSliceModuleMemory()
})

it('hydrates queued review repository identity and rejects a superseded queue lookup', async () => {
  const store = createTestStore()
  const wt = makeWorktree({
    id: 'repo1::/path/wt1',
    repoId: 'repo1',
    path: '/path/wt1',
    branch: 'refs/heads/feature'
  })
  const queued = (number: number): AppState['prCache'] => ({
    'repo1::feature': {
      fetchedAt: Date.now(),
      data: {
        number,
        title: 'Queued review',
        state: 'open',
        url: `https://github.com/canonical/repo/pull/${number}`,
        checksStatus: 'success',
        updatedAt: '2026-09-07T00:00:00Z',
        mergeable: 'UNKNOWN'
      }
    }
  })
  store.setState({
    repos: [
      {
        id: 'repo1',
        path: '/repo1',
        displayName: 'Repo',
        badgeColor: '#000',
        addedAt: 0,
        executionHostId: 'local'
      }
    ],
    worktreesByRepo: { repo1: [wt] },
    prCache: queued(42)
  } as Partial<AppState>)
  const target = reviewTarget('contributor', 'feature')
  let resolve!: (value: unknown) => void
  mockApi.worktrees.resolvePrBase.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done
      })
  )
  const pending = store.getState().ensureHostedReviewPushTarget(wt.id)
  await Promise.resolve()
  store.setState({ prCache: queued(43) })
  resolve({ baseBranch: 'contributor/feature', pushTarget: target })
  await pending
  expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  mockApi.worktrees.resolvePrBase.mockResolvedValueOnce({
    baseBranch: 'contributor/feature',
    pushTarget: target
  })
  await store.getState().ensureHostedReviewPushTarget(wt.id)
  expect(mockApi.worktrees.resolvePrBase).toHaveBeenLastCalledWith({
    repoId: 'repo1',
    prNumber: 43
  })
  expect(mockApi.worktrees.updateMeta).toHaveBeenCalledWith(
    expect.objectContaining({ updates: { pushTarget: target } })
  )
})
