import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { create } from 'zustand'
import type { AppState } from '../types'
import type { CombinedDiffReviewState, Worktree } from '../../../../shared/types'
import { createCombinedDiffReviewSlice } from './combined-diff-review'

const runtimeMocks = vi.hoisted(() => ({
  callRuntimeRpc: vi.fn(),
  getActiveRuntimeTarget: vi.fn((settings: { activeRuntimeEnvironmentId?: string | null }) =>
    settings?.activeRuntimeEnvironmentId
      ? { kind: 'remote' as const, runtimeEnvironmentId: settings.activeRuntimeEnvironmentId }
      : { kind: 'local' as const }
  )
}))

vi.mock('../../runtime/runtime-rpc-client', () => runtimeMocks)

const updateMeta = vi.fn().mockResolvedValue(undefined)
const recordFeatureInteraction = vi.fn()

const mockApi = { worktrees: { updateMeta } }

// @ts-expect-error -- focused store slice test mock
globalThis.window = { api: mockApi }

const REPO = 'repo1'
const WT = 'repo1::/path/wt'

function makeWorktree(combinedDiffReview?: CombinedDiffReviewState): Worktree {
  return {
    id: WT,
    repoId: REPO,
    path: '/path/wt',
    head: 'abc',
    branch: 'refs/heads/feature',
    isBare: false,
    isMainWorktree: false,
    displayName: 'feature',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    combinedDiffReview
  }
}

function createTestStore() {
  return create<AppState>()(
    (...a) =>
      ({
        ...createCombinedDiffReviewSlice(...a),
        worktreesByRepo: { [REPO]: [makeWorktree()] },
        repos: [],
        settings: null,
        recordFeatureInteraction
      }) as unknown as AppState
  )
}

describe('combined diff review slice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    updateMeta.mockResolvedValue(undefined)
    runtimeMocks.callRuntimeRpc.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('optimistically marks a file viewed and persists local metadata', async () => {
    const store = createTestStore()

    await expect(
      store.getState().setCombinedDiffFileViewed(WT, 'unstaged:src/app.ts', 'd1', true)
    ).resolves.toBe(true)

    const review = store.getState().getCombinedDiffReview(WT)
    expect(review.files['unstaged:src/app.ts']).toEqual({
      key: 'unstaged:src/app.ts',
      reviewedAt: 1000,
      diffIdentity: 'd1'
    })
    expect(updateMeta).toHaveBeenCalledWith({
      worktreeId: WT,
      updates: { combinedDiffReview: review }
    })
    expect(recordFeatureInteraction).toHaveBeenCalledWith('review-viewed-files')
  })

  it('rolls back optimistic state when local persistence fails', async () => {
    const store = createTestStore()
    updateMeta.mockRejectedValueOnce(new Error('disk full'))

    await expect(
      store.getState().setCombinedDiffFileViewed(WT, 'unstaged:src/app.ts', 'd1', true)
    ).resolves.toBe(false)

    expect(store.getState().getCombinedDiffReview(WT).files).toEqual({})
    expect(recordFeatureInteraction).not.toHaveBeenCalled()
  })

  it('reconciles stale identities and persists only when changed', async () => {
    const stale: CombinedDiffReviewState = {
      version: 1,
      files: {
        'unstaged:src/app.ts': {
          key: 'unstaged:src/app.ts',
          reviewedAt: 500,
          diffIdentity: 'old'
        }
      }
    }
    const store = createTestStore()
    store.setState({ worktreesByRepo: { [REPO]: [makeWorktree(stale)] } })

    await store
      .getState()
      .reconcileCombinedDiffReview(WT, [{ key: 'unstaged:src/app.ts', diffIdentity: 'new' }])

    expect(store.getState().getCombinedDiffReview(WT).files).toEqual({})
    expect(updateMeta).toHaveBeenCalledTimes(1)
    expect(recordFeatureInteraction).not.toHaveBeenCalled()

    await store.getState().reconcileCombinedDiffReview(WT, [])

    expect(updateMeta).toHaveBeenCalledTimes(1)
  })

  it('returns the empty sentinel for malformed persisted state', () => {
    const store = createTestStore()
    // Why: cross-version SSH peers / hand-edited orca-data.json can persist a
    // record with a missing or non-object `files`; the selector must not hand
    // that to consumers that dereference `.files` directly.
    store.setState({
      worktreesByRepo: {
        [REPO]: [makeWorktree({ version: 1 } as unknown as CombinedDiffReviewState)]
      }
    })

    const review = store.getState().getCombinedDiffReview(WT)
    expect(review.files).toEqual({})
  })

  it('persists viewed state through the SSH worktree.set path', async () => {
    const store = createTestStore()
    store.setState({ settings: { activeRuntimeEnvironmentId: 'env-1' } as AppState['settings'] })

    await store.getState().setCombinedDiffFileViewed(WT, 'combined-branch:src/app.ts', 'd2', true)

    expect(updateMeta).not.toHaveBeenCalled()
    expect(runtimeMocks.callRuntimeRpc).toHaveBeenCalledWith(
      { kind: 'remote', runtimeEnvironmentId: 'env-1' },
      'worktree.set',
      {
        worktree: `id:${WT}`,
        combinedDiffReview: store.getState().getCombinedDiffReview(WT)
      },
      { timeoutMs: 15_000 }
    )
  })
})
