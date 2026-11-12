import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { Worktree } from '../../../../../../shared/worktree/types'
import { clearHugeRepoWarningDismissalsForTests } from '@/lib/source-control/warnings/source-control-huge-repo-warning-dismissals'
import { makeDetectedResult } from './worktrees-detected-listing-fixtures'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  worktreeListMock
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

  it('does not merge a stale listing row over a newer branch and review link', async () => {
    const store = createTestStore()
    const worktreeId = 'repo1::/path/wt1'
    const requestStarted = makeWorktree({
      id: worktreeId,
      repoId: 'repo1',
      path: '/path/wt1',
      branch: 'refs/heads/feature-one',
      head: 'first-head',
      linkedPR: 101
    })
    const staleResponse = makeWorktree({
      ...requestStarted,
      branch: 'refs/heads/feature-two',
      head: 'stale-head',
      linkedPR: 202
    })
    let resolveListing!: (worktrees: Worktree[]) => void
    const listing = new Promise<Worktree[]>((resolve) => {
      resolveListing = resolve
    })
    worktreeListMock.mockReturnValueOnce(listing)
    store.setState({ worktreesByRepo: { repo1: [requestStarted] } } as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(worktreeListMock).toHaveBeenCalledTimes(1))
    const latest = makeWorktree({
      ...requestStarted,
      branch: 'refs/heads/feature-three',
      head: 'latest-head',
      linkedPR: 303
    })
    store.setState({ worktreesByRepo: { repo1: [latest] } } as Partial<AppState>)
    resolveListing([staleResponse])

    await refresh

    expect(store.getState().worktreesByRepo.repo1).toEqual([latest])
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()
  })

  it('does not merge stale manual order over a reorder completed during refresh', async () => {
    const store = createTestStore()
    const daily = makeWorktree({
      id: 'repo1::/path/daily',
      repoId: 'repo1',
      path: '/path/daily',
      manualOrder: 20
    })
    const relay = makeWorktree({
      id: 'repo1::/path/relay',
      repoId: 'repo1',
      path: '/path/relay',
      manualOrder: 10
    })
    const refreshedDaily = { ...daily, head: 'def456' }
    const detected = makeDetectedResult('repo1', [daily, relay])
    let resolveListing!: (worktrees: Worktree[]) => void
    const listing = new Promise<Worktree[]>((resolve) => {
      resolveListing = resolve
    })
    worktreeListMock.mockReturnValueOnce(listing)
    store.setState({
      worktreesByRepo: { repo1: [daily, relay] },
      detectedWorktreesByRepo: { repo1: detected }
    } as Partial<AppState>)

    const refresh = store.getState().fetchWorktrees('repo1')
    await vi.waitFor(() => expect(worktreeListMock).toHaveBeenCalledTimes(1))
    await store.getState().updateWorktreesMeta([
      { worktreeId: daily.id, updates: { manualOrder: 100 } },
      { worktreeId: relay.id, updates: { manualOrder: 200 } }
    ])
    resolveListing([refreshedDaily, relay])

    await refresh

    expect(store.getState().worktreesByRepo.repo1.map((worktree) => worktree.manualOrder)).toEqual([
      100, 200
    ])
    expect(
      store
        .getState()
        .detectedWorktreesByRepo.repo1.worktrees.map((worktree) => worktree.manualOrder)
    ).toEqual([100, 200])
    expect(store.getState().worktreesByRepo.repo1[0]?.head).toBe('def456')
  })

  it('does not merge a host response captured before an optimistic rename settles', async () => {
    const store = createTestStore()
    const existing = makeWorktree({
      id: 'repo1::/path/wt1',
      repoId: 'repo1',
      path: '/path/wt1',
      displayName: 'old label',
      displayNameMode: 'automatic'
    })
    const staleResponse = { ...existing }
    let resolvePersist!: () => void
    mockApi.worktrees.updateMeta.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePersist = resolve
      })
    )
    worktreeListMock.mockResolvedValueOnce([staleResponse])
    store.setState({ worktreesByRepo: { repo1: [existing] } } as Partial<AppState>)

    const rename = store.getState().updateWorktreeMeta(existing.id, { displayName: 'new label' })
    await vi.waitFor(() => expect(mockApi.worktrees.updateMeta).toHaveBeenCalledTimes(1))
    const refresh = store.getState().fetchWorktrees('repo1')

    await refresh
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      displayName: 'new label',
      displayNameMode: 'fixed'
    })

    resolvePersist()
    await rename
  })
})
