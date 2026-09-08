import { expect, it, vi } from 'vitest'
import { startWorkspaceCleanupBackgroundRemoval } from './workspace-cleanup-background-removal'
import { makeCandidate } from './workspace-cleanup-presentation-fixtures'

vi.mock('sonner', () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() }
}))

async function settleBackgroundRemoval(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve()
  }
}

it('holds one snapshot prune batch across the sequential cleanup removals', async () => {
  const first = makeCandidate()
  const second = makeCandidate({
    worktreeId: 'repo-1::/repo/beta',
    displayName: 'beta',
    branch: 'beta',
    path: '/repo/beta'
  })
  const events: string[] = []
  const removeCandidates = vi.fn(async (worktreeIds: readonly string[]) => {
    events.push(`remove:${worktreeIds[0]}`)
    return { removedIds: [...worktreeIds], removedIdentities: [...worktreeIds], failures: [] }
  })
  const onResult = vi.fn()

  startWorkspaceCleanupBackgroundRemoval({
    candidates: [first, second],
    removeCandidates,
    onResult,
    onProgress: vi.fn(),
    snapshotPruneBatch: {
      batchId: 'batch-1',
      begin: async () => {
        events.push('begin')
      },
      finish: async () => {
        events.push('finish')
      }
    }
  })
  await settleBackgroundRemoval()

  expect(removeCandidates).toHaveBeenNthCalledWith(1, [first.worktreeId], {
    approvedCandidates: [first],
    snapshotPruneBatchId: 'batch-1'
  })
  expect(removeCandidates).toHaveBeenNthCalledWith(2, [second.worktreeId], {
    approvedCandidates: [second],
    snapshotPruneBatchId: 'batch-1'
  })
  expect(events).toEqual([
    'begin',
    `remove:${first.worktreeId}`,
    `remove:${second.worktreeId}`,
    'finish'
  ])
  await vi.waitFor(() => {
    expect(onResult).toHaveBeenCalledWith({
      removedIds: [first.worktreeId, second.worktreeId],
      removedIdentities: [first.worktreeId, second.worktreeId],
      failures: []
    })
  })
})
