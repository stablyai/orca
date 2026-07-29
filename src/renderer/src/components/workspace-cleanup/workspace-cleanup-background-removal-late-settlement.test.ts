import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { startWorkspaceCleanupBackgroundRemoval } from './workspace-cleanup-background-removal'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

vi.mock('sonner', () => ({
  toast: {
    error: vi.fn(),
    info: vi.fn(),
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

  it('reports later child settlements while a post-batch ancestor retry is stalled', async () => {
    const firstParent = makeCandidate({
      worktreeId: 'repo-1::/repo/a',
      displayName: 'first parent',
      branch: 'first-parent',
      path: '/repo/a'
    })
    const firstChild = makeCandidate({
      worktreeId: 'repo-1::/repo/a/child-long',
      displayName: 'first child',
      branch: 'first-child',
      path: '/repo/a/child-long'
    })
    const secondParent = makeCandidate({
      worktreeId: 'repo-1::/repo/bb',
      displayName: 'second parent',
      branch: 'second-parent',
      path: '/repo/bb'
    })
    const secondChild = makeCandidate({
      worktreeId: 'repo-1::/repo/bb/c',
      displayName: 'second child',
      branch: 'second-child',
      path: '/repo/bb/c'
    })
    let resolveFirstChild: (result: { removedIds: string[]; failures: [] }) => void = () => {}
    let resolveSecondChild: (result: { removedIds: string[]; failures: [] }) => void = () => {}
    const removeCandidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ removedIds: string[]; failures: [] }>((resolve) => {
            resolveFirstChild = resolve
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise<{ removedIds: string[]; failures: [] }>((resolve) => {
            resolveSecondChild = resolve
          })
      )
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockResolvedValueOnce({ removedIds: [secondParent.worktreeId], failures: [] })
    const onLateResult = vi.fn()

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [firstParent, firstChild, secondParent, secondChild],
      removeCandidates,
      onProgress: vi.fn(),
      onResult: vi.fn(),
      onLateResult,
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(20)
    await settleBackgroundRemoval()
    resolveFirstChild({ removedIds: [firstChild.worktreeId], failures: [] })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(3, [firstParent.worktreeId], {
      approvedCandidates: [firstParent]
    })
    expect(onLateResult).toHaveBeenNthCalledWith(1, {
      removedIds: [firstChild.worktreeId],
      failures: []
    })

    resolveSecondChild({ removedIds: [secondChild.worktreeId], failures: [] })
    await settleBackgroundRemoval()

    expect(onLateResult).toHaveBeenNthCalledWith(2, {
      removedIds: [secondChild.worktreeId],
      failures: []
    })
    expect(removeCandidates).toHaveBeenCalledTimes(3)

    await vi.advanceTimersByTimeAsync(10)
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(4, [secondParent.worktreeId], {
      approvedCandidates: [secondParent]
    })
    expect(onLateResult).toHaveBeenCalledWith({
      removedIds: [secondParent.worktreeId],
      failures: []
    })
    expect(toast.info).toHaveBeenCalledWith('Still removing workspaces: 1')
  })

  it('retries an unblocked ancestor when immediate late-result reporting throws', async () => {
    const parent = makeCandidate({
      worktreeId: 'repo-1::/repo/parent',
      displayName: 'parent',
      branch: 'parent',
      path: '/repo/parent'
    })
    const child = makeCandidate({
      worktreeId: 'repo-1::/repo/parent/child',
      displayName: 'child',
      branch: 'child',
      path: '/repo/parent/child'
    })
    let resolveChild: (result: { removedIds: string[]; failures: [] }) => void = () => {}
    const removeCandidates = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{ removedIds: string[]; failures: [] }>((resolve) => {
            resolveChild = resolve
          })
      )
      .mockResolvedValueOnce({ removedIds: [parent.worktreeId], failures: [] })
    vi.mocked(toast.success).mockImplementationOnce(() => {
      throw new Error('toast renderer failed')
    })

    startWorkspaceCleanupBackgroundRemoval({
      candidates: [parent, child],
      removeCandidates,
      onProgress: vi.fn(),
      onResult: vi.fn(),
      onLateResult: vi.fn(),
      removalTimeoutMs: 5,
      removalSettlementGraceMs: 5
    })

    await vi.advanceTimersByTimeAsync(10)
    await settleBackgroundRemoval()
    resolveChild({ removedIds: [child.worktreeId], failures: [] })
    await settleBackgroundRemoval()

    expect(removeCandidates).toHaveBeenNthCalledWith(2, [parent.worktreeId], {
      approvedCandidates: [parent]
    })
  })
})
