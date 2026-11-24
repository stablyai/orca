// @vitest-environment happy-dom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { makeFacetCandidate as makeCandidate } from '../query/workspace-cleanup-facet.test.fixture'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { useWorkspaceCleanupRemoval } from './use-workspace-cleanup-removal'
import { useWorkspaceCleanupRunStore } from './run/workspace-cleanup-run-store'
import { WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS } from './run/workspace-cleanup-run-reporter'

vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } }))

// Production timeout (120s) plus settlement grace (5s).
const UNRESOLVED_AFTER_MS = 125_000

beforeEach(() => {
  vi.useFakeTimers()
  // No snapshot-prune IPC in tests; the batch runs without it.
  vi.stubGlobal('api', { workspaceCleanup: {} })
  useAppStore.setState(useAppStore.getInitialState(), true)
  useWorkspaceCleanupRunStore.setState({ run: null })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('useWorkspaceCleanupRemoval Browse failures', () => {
  it('keeps the definitive retry error and its Delete anyway through Done', async () => {
    const rows = ['/repo/café', '/repo/café', '/repo/café/child'].map((path) =>
      makeCandidate({ worktreeId: `repo-1::${path}`, path })
    )
    const [first, second, child] = rows
    const removals = new Map(
      rows.map((row) => [row.worktreeId, Promise.withResolvers<WorkspaceCleanupRemoveResult>()])
    )
    useAppStore.setState({
      removeWorkspaceCleanupCandidates: ([worktreeId]: readonly string[]) =>
        removals.get(worktreeId)!.promise
    })
    const complete = (row: WorkspaceCleanupCandidate): void => {
      removals.get(row.worktreeId)!.resolve({
        removedIds: [row.worktreeId],
        removedIdentities: [getWorkspaceCleanupCandidateIdentity(row)],
        failures: []
      })
    }
    const definitive = {
      worktreeId: first.worktreeId,
      displayName: first.displayName,
      message: 'First parent workspace remained locked',
      canDeleteAnyway: true
    }
    const firstIdentity = getWorkspaceCleanupCandidateIdentity(first)
    const { result } = renderHook(() =>
      useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
    )
    const expectDefinitive = (): void => {
      expect(result.current.rowFailures[firstIdentity]).toMatchObject({
        message: definitive.message,
        canDeleteAnyway: true
      })
      expect(result.current.rowFailures[firstIdentity]?.provisional).toBeFalsy()
    }

    act(() => result.current.confirmRemove(rows))
    // Every row times out, so the batch finishes with provisional failures only.
    await act(() => vi.advanceTimersByTimeAsync(UNRESOLVED_AFTER_MS * rows.length))
    complete(child)
    await act(() => vi.advanceTimersByTimeAsync(0))

    removals.get(first.worktreeId)!.resolve({
      removedIds: [],
      removedIdentities: [],
      failures: [definitive]
    })
    await act(() => vi.advanceTimersByTimeAsync(0))
    // The sibling's automatic retry settles; the reconcile then reports both retries together.
    complete(second)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expectDefinitive()
    // A repeated timeout for the first row (as the batch can report) must not replace it.
    await act(() => vi.advanceTimersByTimeAsync(UNRESOLVED_AFTER_MS))
    expectDefinitive()

    // Done dismisses the run; Browse must still show what the summary showed.
    act(() => useWorkspaceCleanupRunStore.getState().dismissRun())
    await act(() => vi.advanceTimersByTimeAsync(WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS))
    expectDefinitive()
  })
})
