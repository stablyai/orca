// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { makeFacetCandidate as makeCandidate } from '../../query/workspace-cleanup-facet.test.fixture'
import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import {
  createWorkspaceCleanupRunReporter,
  WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS
} from './workspace-cleanup-run-reporter'
import { useWorkspaceCleanupRunStore } from './workspace-cleanup-run-store'
import { startWorkspaceCleanupBackgroundRemoval } from '../settlement/workspace-cleanup-background-removal'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

// A removal reads as timed out after timeout + grace.
const TIMEOUT_MS = 10
const GRACE_MS = 5
const UNRESOLVED_AFTER_MS = TIMEOUT_MS + GRACE_MS

const row = (path: string): WorkspaceCleanupCandidate =>
  makeCandidate({ worktreeId: `repo-1::${path}`, path, displayName: path })
const statusOf = (candidate: WorkspaceCleanupCandidate) =>
  useWorkspaceCleanupRunStore
    .getState()
    .run?.rows.find((entry) => entry.identity === getWorkspaceCleanupCandidateIdentity(candidate))
    ?.status

function startRemoval(rows: WorkspaceCleanupCandidate[]) {
  const removals = new Map(
    rows.map((entry) => [entry.worktreeId, Promise.withResolvers<WorkspaceCleanupRemoveResult>()])
  )
  const reporter = createWorkspaceCleanupRunReporter(
    useWorkspaceCleanupRunStore.getState().startRun(rows)
  )
  startWorkspaceCleanupBackgroundRemoval({
    ...reporter,
    candidates: rows,
    // Every call for a row returns that row's one pending promise, so a restart stays pending too.
    removeCandidates: ([worktreeId]) => removals.get(worktreeId)!.promise,
    onProgress: () => {},
    removalTimeoutMs: TIMEOUT_MS,
    removalSettlementGraceMs: GRACE_MS
  })
  const complete = (entry: WorkspaceCleanupCandidate): void => {
    removals.get(entry.worktreeId)!.resolve({
      removedIds: [entry.worktreeId],
      removedIdentities: [getWorkspaceCleanupCandidateIdentity(entry)],
      failures: []
    })
  }
  return { complete }
}

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useWorkspaceCleanupRunStore.setState({ run: null })
})
afterEach(() => {
  vi.useRealTimers()
})

// A parent skipped behind a timed-out child gets a provisional ceiling. When the child settles,
// the parent is physically deleted again; that start must retire the skip's ceiling, so the
// original deadline passes without expiring the newer delete, which then gets its own ceiling.
describe('workspace cleanup run: physical restarts keep their own deadline', () => {
  it('restarts an unblocked parent in the batch loop without the skip deadline expiring it', async () => {
    const child = row('/repo/parent/child')
    const parent = row('/repo/parent')
    // Shorter path, so it runs after the parent skip and keeps the batch open while the child settles.
    const sibling = row('/s')
    const { complete } = startRemoval([child, parent, sibling])

    await vi.advanceTimersByTimeAsync(UNRESOLVED_AFTER_MS)
    const skipDeadline = UNRESOLVED_AFTER_MS + WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS
    expect(statusOf(parent)).toBe('provisional')

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    complete(child)
    await vi.advanceTimersByTimeAsync(0)
    expect(statusOf(child)).toBe('deleted')

    // The sibling times out, then the batch loop starts the unblocked parent again.
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS)
    expect(statusOf(parent)).toBe('deleting')
    const restartedAt = 2 * UNRESOLVED_AFTER_MS
    await vi.advanceTimersByTimeAsync(UNRESOLVED_AFTER_MS)
    expect(statusOf(parent)).toBe('provisional')

    const restartDeadline =
      restartedAt + UNRESOLVED_AFTER_MS + WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS
    const elapsed = restartedAt + UNRESOLVED_AFTER_MS
    await vi.advanceTimersByTimeAsync(skipDeadline + 1 - elapsed)
    expect(statusOf(parent)).toBe('provisional')

    await vi.advanceTimersByTimeAsync(restartDeadline - (skipDeadline + 1))
    expect(statusOf(parent)).toBe('failed')
  })

  it('retries an unblocked parent after the batch without the skip deadline expiring it', async () => {
    const child = row('/repo/parent/child')
    const parent = row('/repo/parent')
    const { complete } = startRemoval([child, parent])

    // Child times out, parent is skipped behind it, and the batch ends.
    await vi.advanceTimersByTimeAsync(UNRESOLVED_AFTER_MS)
    const skipDeadline = UNRESOLVED_AFTER_MS + WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS
    expect(statusOf(parent)).toBe('provisional')

    await vi.advanceTimersByTimeAsync(GRACE_MS)
    complete(child)
    await vi.advanceTimersByTimeAsync(0)
    // The post-batch reconcile deletes the parent automatically.
    expect(statusOf(child)).toBe('deleted')
    expect(statusOf(parent)).toBe('deleting')
    const retriedAt = UNRESOLVED_AFTER_MS + GRACE_MS
    await vi.advanceTimersByTimeAsync(UNRESOLVED_AFTER_MS)
    expect(statusOf(parent)).toBe('provisional')

    const retryDeadline = retriedAt + UNRESOLVED_AFTER_MS + WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS
    const elapsed = retriedAt + UNRESOLVED_AFTER_MS
    await vi.advanceTimersByTimeAsync(skipDeadline + 1 - elapsed)
    expect(statusOf(parent)).toBe('provisional')

    await vi.advanceTimersByTimeAsync(retryDeadline - (skipDeadline + 1))
    expect(statusOf(parent)).toBe('failed')
  })
})
