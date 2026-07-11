import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { startWorkspaceCleanupBackgroundRemoval } from './workspace-cleanup-background-removal'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn()
  }
}))

async function settleBackgroundRemoval(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

describe('workspace cleanup late settlement reconciliation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('uses a post-grace child success that arrives before its parent is considered', async () => {
    const parent = makeCandidate({
      worktreeId: 'repo-1::/repo/p',
      displayName: 'parent',
      branch: 'parent',
      path: '/repo/p'
    })
    const child = makeCandidate({
      worktreeId: 'repo-1::/repo/p/child-long',
      displayName: 'child',
      branch: 'child',
      path: '/repo/p/child-long'
    })
    const unrelated = makeCandidate({
      worktreeId: 'repo-1::/repo/other',
      displayName: 'other',
      branch: 'other',
      path: '/repo/other'
    })
    let resolveChild: (result: { removedIds: string[]; failures: [] }) => void = () => {}
    let resolveUnrelated: (result: { removedIds: string[]; failures: [] }) => void = () => {}
    const removeCandidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ removedIds: string[]; failures: [] }>((resolve) => {
            resolveChild = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ removedIds: string[]; failures: [] }>((resolve) => {
            resolveUnrelated = resolve
          })
      )
      .mockResolvedValueOnce({ removedIds: [parent.worktreeId], failures: [] })
    const onResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, unrelated, child],
      removeCandidates,
      onProgress: vi.fn(),
      onResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(10)
    expect(removeCandidates).toHaveBeenCalledTimes(2)
    resolveChild({ removedIds: [child.worktreeId], failures: [] })
    await settleBackgroundRemoval()
    resolveUnrelated({ removedIds: [unrelated.worktreeId], failures: [] })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(3, [parent.worktreeId], {
      approvedCandidates: [parent]
    })
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [child.worktreeId, unrelated.worktreeId, parent.worktreeId],
      failures: []
    })
    expect(toast.error).not.toHaveBeenCalled()
  })
})
