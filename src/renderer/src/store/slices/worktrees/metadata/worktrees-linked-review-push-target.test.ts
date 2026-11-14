import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../../types'
import type { RuntimeEnvironmentCallRequest } from '../../../../runtime/rpc/testing/runtime-compatibility-test-fixture'
import { makeWorktree } from '../worktree.test-fixture'
import {
  createTestStore,
  mockApi,
  resetRemoteRuntimeMocks,
  resetWorktreeSliceModuleMemory,
  runtimeEnvironmentCall
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

describe('worktree remote runtime mutations', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetRemoteRuntimeMocks()
  })

  it('preserves a concurrent review selection while an attachment lookup is pending', async () => {
    const store = createTestStore()
    const wt = makeWorktree({ id: 'repo1::/path/wt1', repoId: 'repo1', path: '/path/wt1' })
    const firstLookup = Promise.withResolvers<{
      baseBranch: string
      pushTarget: { remoteName: string; branchName: string }
    }>()
    mockApi.worktrees.resolvePrBase.mockReturnValueOnce(firstLookup.promise)
    store.setState({
      repos: [
        { id: 'repo1', path: '/repo1', displayName: 'Repo 1', badgeColor: '#000', addedAt: 0 }
      ],
      worktreesByRepo: { repo1: [wt] }
    })
    const pending = store.getState().updateWorktreeMeta(wt.id, {
      linkedItems: [{ provider: 'github', type: 'pr', number: 1 }]
    })
    const currentTarget = { remoteName: 'origin', branchName: 'pr-2' }
    await store.getState().updateWorktreeMeta(wt.id, { linkedPR: 2, pushTarget: currentTarget })
    firstLookup.resolve({
      baseBranch: 'origin/pr-1',
      pushTarget: { remoteName: 'origin', branchName: 'pr-1' }
    })
    expect(await pending).toEqual({ ok: true })
    expect(store.getState().worktreesByRepo.repo1[0]).toMatchObject({
      linkedPR: 2,
      pushTarget: currentTarget,
      linkedItems: [
        { provider: 'github', type: 'pr', number: 2 },
        { provider: 'github', type: 'pr', number: 1 }
      ]
    })
    const lastWrite = mockApi.worktrees.updateMeta.mock.lastCall?.[0].updates
    expect(lastWrite?.linkedPR).toBe(2)
    expect(lastWrite).not.toHaveProperty('pushTarget')
  })

  it('cleans up the in-flight lookup when restore is skipped for a genuinely ambiguous owner', async () => {
    const store = createTestStore()
    const worktreeId = 'repo-shared::/same/path'
    const pushTarget = { remoteName: 'fork', branchName: 'feature/disambiguated' }
    const ownedWorktree = makeWorktree({
      id: worktreeId,
      repoId: 'repo-shared',
      hostId: 'ssh:ssh-a',
      runtimeOwnerEnvironmentId: 'hub-a',
      linkedPR: 123
    })
    runtimeEnvironmentCall.mockImplementation(({ method }: RuntimeEnvironmentCallRequest) => {
      if (method === 'worktree.resolvePrBase') {
        return Promise.resolve({
          id: 'rpc-ambiguous-resolve-pr-base',
          ok: true,
          result: { baseBranch: 'fork-head', pushTarget },
          _meta: { runtimeId: 'hub-a' }
        })
      }
      if (method === 'worktree.set') {
        return Promise.resolve({
          id: 'rpc-ambiguous-set-worktree',
          ok: true,
          result: { worktree: { ...ownedWorktree, pushTarget } },
          _meta: { runtimeId: 'hub-a' }
        })
      }
      throw new Error(`Unexpected runtime method ${method}`)
    })
    store.setState({
      settings: { activeRuntimeEnvironmentId: 'hub-c' } as never,
      worktreesByRepo: {
        'repo-shared': [
          ownedWorktree,
          makeWorktree({
            id: worktreeId,
            repoId: 'repo-shared',
            hostId: 'ssh:ssh-b',
            runtimeOwnerEnvironmentId: 'hub-b',
            linkedPR: 123
          })
        ]
      }
    } as Partial<AppState>)

    await expect(store.getState().ensureHostedReviewPushTarget(worktreeId)).resolves.toBeUndefined()

    expect(runtimeEnvironmentCall).not.toHaveBeenCalled()
    expect(mockApi.worktrees.resolvePrBase).not.toHaveBeenCalled()
    expect(mockApi.worktrees.updateMeta).not.toHaveBeenCalled()

    // Remove twin ambiguity and retry; skipped lookups must not leave stale in-flight markers.
    store.setState({ worktreesByRepo: { 'repo-shared': [ownedWorktree] } } as Partial<AppState>)

    await store.getState().ensureHostedReviewPushTarget(worktreeId)

    expect(runtimeEnvironmentCall).toHaveBeenCalledWith(
      expect.objectContaining({
        selector: 'hub-a',
        method: 'worktree.resolvePrBase',
        params: expect.objectContaining({ repo: 'repo-shared', prNumber: 123 }),
        timeoutMs: 30_000
      })
    )
    expect(store.getState().worktreesByRepo['repo-shared'][0]?.pushTarget).toEqual(pushTarget)
  })
})
