// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { WorkspaceCleanupRemoveResult } from '@/store/slices/workspace-cleanup/workspace-cleanup-removal'
import { makeFacetCandidate as makeCandidate } from '../../query/workspace-cleanup-facet.test.fixture'
import type { WorkspaceCleanupCandidate } from '../../../../../../shared/workspace-cleanup/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import { WorkspaceCleanupRunCard } from './WorkspaceCleanupRunCard'
import {
  createWorkspaceCleanupRunReporter,
  WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS
} from './workspace-cleanup-run-reporter'
import {
  getWorkspaceCleanupRunCounts,
  getWorkspaceCleanupRunPhase,
  useWorkspaceCleanupRunStore,
  type WorkspaceCleanupRun
} from './workspace-cleanup-run-store'
import { orderWorkspaceCleanupRunRows } from './workspace-cleanup-run-step'
import { startWorkspaceCleanupBackgroundRemoval } from '../settlement/workspace-cleanup-background-removal'

const candidates = ['a', 'b', 'c'].map((name) =>
  makeCandidate({ worktreeId: `repo-1::/repo/${name}`, displayName: name })
)
const identity = (index: number): string => getWorkspaceCleanupCandidateIdentity(candidates[index])
const failure = (index: number, extra: { provisional?: boolean; message?: string } = {}) => ({
  worktreeId: candidates[index].worktreeId,
  displayName: candidates[index].displayName,
  message: extra.message ?? 'Busy',
  canDeleteAnyway: true,
  ...(extra.provisional ? { provisional: true } : {})
})
const result = (removed: number[], failures: ReturnType<typeof failure>[] = []) => ({
  removedIds: removed.map((index) => candidates[index].worktreeId),
  removedIdentities: removed.map(identity),
  failures
})
const HALF_CEILING = WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS / 2
const store = () => useWorkspaceCleanupRunStore.getState()
const run = (): WorkspaceCleanupRun => store().run!
const statuses = () => run().rows.map((row) => row.status)

beforeEach(() => {
  vi.useFakeTimers()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useWorkspaceCleanupRunStore.setState({ run: null })
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('workspace cleanup run', () => {
  it('finishes only when every row is terminal, with failures listed first', () => {
    const reporter = createWorkspaceCleanupRunReporter(store().startRun(candidates))
    act(() => {
      reporter.onRowStarted(candidates[0])
      reporter.onRowRemoved(candidates[0])
      reporter.onRowFailed(failure(1))
    })
    expect(getWorkspaceCleanupRunPhase(run())).toBe('running')
    act(() => reporter.onRowFailed(failure(2)))
    expect(getWorkspaceCleanupRunPhase(run())).toBe('finished')
    expect(getWorkspaceCleanupRunCounts(run())).toEqual({
      total: 3,
      deleted: 1,
      failed: 2,
      settled: 3
    })
    expect(orderWorkspaceCleanupRunRows(run()).map((row) => row.status)).toEqual([
      'failed',
      'failed',
      'deleted'
    ])
    expect(run().rows[1].failure?.canDeleteAnyway).toBe(true)
  })

  it('keeps the run open through a timeout, a post-batch retry timeout and the final settlement', () => {
    const reporter = createWorkspaceCleanupRunReporter(
      store().startRun([candidates[0], candidates[1]])
    )
    act(() => {
      reporter.onRowRemoved(candidates[1])
      reporter.onRowFailed(failure(0, { provisional: true }))
      reporter.onResult(result([1], [failure(0, { provisional: true })]))
    })
    expect(statuses()).toEqual(['provisional', 'deleted'])
    expect(getWorkspaceCleanupRunPhase(run())).toBe('running')
    // A late settlement that is itself provisional (post-batch retry timeout) changes nothing.
    act(() => reporter.onLateResult(result([], [failure(0, { provisional: true })])))
    expect(getWorkspaceCleanupRunPhase(run())).toBe('running')
    act(() => reporter.onLateResult(result([0])))
    expect(statuses()).toEqual(['deleted', 'deleted'])
    expect(getWorkspaceCleanupRunPhase(run())).toBe('finished')
  })

  it('gives up on a row that never settles after the ceiling', () => {
    const reporter = createWorkspaceCleanupRunReporter(store().startRun([candidates[0]]))
    act(() => reporter.onRowFailed(failure(0, { provisional: true })))
    act(() => {
      vi.advanceTimersByTime(WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS)
    })
    expect(statuses()).toEqual(['failed'])
    expect(getWorkspaceCleanupRunPhase(run())).toBe('finished')
  })

  it('ignores settlements from a replaced or dismissed run', () => {
    const old = createWorkspaceCleanupRunReporter(store().startRun([candidates[0]]))
    act(() => store().dismissRun())
    act(() => store().startRun([candidates[0]]))
    act(() => old.onLateResult(result([0])))
    expect(statuses()).toEqual(['waiting'])
    act(() => store().dismissRun())
    act(() => old.onRowFailed(failure(0)))
    expect(store().run).toBeNull()
  })

  it('joins a retry to the same run without letting the old attempt expire it', () => {
    const first = createWorkspaceCleanupRunReporter(store().startRun([candidates[0]]))
    act(() => first.onRowFailed(failure(0, { provisional: true })))
    act(() => vi.advanceTimersByTime(HALF_CEILING))
    const started = store().beginRowRetry(candidates[0])
    expect(started.runId).toBe(run().id)
    expect(statuses()).toEqual(['deleting'])
    expect(getWorkspaceCleanupRunPhase(run())).toBe('running')

    const retry = createWorkspaceCleanupRunReporter(started)
    act(() => retry.onRowFailed(failure(0, { provisional: true })))
    // The first attempt's ceiling passes while the retry is still provisional.
    act(() => {
      vi.advanceTimersByTime(HALF_CEILING + 1)
      first.onLateResult(result([], [failure(0, { message: 'old' })]))
    })
    expect(statuses()).toEqual(['provisional'])
    act(() => retry.onLateResult(result([0])))
    expect(statuses()).toEqual(['deleted'])
  })

  it('does not let an earlier provisional timer expire an automatic retry of the same attempt', () => {
    const reporter = createWorkspaceCleanupRunReporter(store().startRun([candidates[0]]))
    // Skipped behind a timed-out child: provisional, with its own expiry timer.
    act(() => reporter.onRowFailed(failure(0, { provisional: true })))
    act(() => vi.advanceTimersByTime(HALF_CEILING))
    // The child settles and the ancestor is deleted automatically, then times out too.
    act(() => reporter.onRowStarted(candidates[0]))
    expect(statuses()).toEqual(['deleting'])
    act(() => reporter.onLateResult(result([], [failure(0, { provisional: true })])))
    act(() => vi.advanceTimersByTime(HALF_CEILING + 1))
    expect(statuses()).toEqual(['provisional'])
    // Only the newer operation's own ceiling gives up on it.
    act(() => vi.advanceTimersByTime(HALF_CEILING))
    expect(statuses()).toEqual(['failed'])
  })

  it('keeps an expired row failed when the batch repeats its timeout, without restarting the ceiling', () => {
    const reporter = createWorkspaceCleanupRunReporter(store().startRun([candidates[0]]))
    act(() => reporter.onRowFailed(failure(0, { provisional: true })))
    act(() => vi.advanceTimersByTime(HALF_CEILING))
    // The batch reports the same timeout again; the first ceiling still applies.
    act(() => reporter.onResult(result([], [failure(0, { provisional: true })])))
    act(() => vi.advanceTimersByTime(HALF_CEILING))
    expect(statuses()).toEqual(['failed'])
    act(() => reporter.onLateResult(result([], [failure(0, { provisional: true })])))
    expect(statuses()).toEqual(['failed'])
    // An authoritative success still lands.
    act(() => reporter.onLateResult(result([0])))
    expect(statuses()).toEqual(['deleted'])
  })

  it('keeps the definitive failure when a sibling retry publishes an older timeout', async () => {
    const rows = ['/repo/cafe\u0301', '/repo/café', '/repo/café/child'].map((path) =>
      makeCandidate({ worktreeId: `repo-1::${path}`, path })
    )
    const [first, second, child] = rows
    const removals = new Map(
      rows.map((row) => [row.worktreeId, Promise.withResolvers<WorkspaceCleanupRemoveResult>()])
    )
    const reporter = createWorkspaceCleanupRunReporter(store().startRun(rows))
    const failureMessage = 'First parent workspace remained locked'
    const lateFailures: WorkspaceCleanupRemoveResult['failures'] = []
    const expectFirstFailure = () => {
      expect(run().rows[0]).toMatchObject({
        status: 'failed',
        failure: { message: failureMessage }
      })
    }
    const complete = (row: WorkspaceCleanupCandidate) => {
      removals.get(row.worktreeId)!.resolve({
        removedIds: [row.worktreeId],
        removedIdentities: [getWorkspaceCleanupCandidateIdentity(row)],
        failures: []
      })
    }

    startWorkspaceCleanupBackgroundRemoval({
      ...reporter,
      candidates: rows,
      removeCandidates: ([worktreeId]) => removals.get(worktreeId)!.promise,
      onProgress: () => {},
      onLateResult: (result) => {
        lateFailures.push(...result.failures)
        reporter.onLateResult(result)
      },
      removalTimeoutMs: 10,
      removalSettlementGraceMs: 5
    })
    await vi.advanceTimersByTimeAsync(15)
    expect(statuses()).toEqual(['provisional', 'provisional', 'provisional'])
    complete(child)
    await vi.advanceTimersByTimeAsync(15)
    expect(statuses()[1]).toBe('deleting')

    removals.get(first.worktreeId)!.reject(new Error(failureMessage))
    await vi.advanceTimersByTimeAsync(0)
    expectFirstFailure()
    complete(second)
    await vi.advanceTimersByTimeAsync(0)
    expectFirstFailure()
    expect(
      lateFailures
        .filter((entry) => entry.worktreeId === first.worktreeId)
        .map((entry) => entry.message)
    ).toEqual([failureMessage])
    await vi.advanceTimersByTimeAsync(WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS)
    expectFirstFailure()

    reporter.onRowStarted(first)
    reporter.onRowFailed({
      worktreeId: first.worktreeId,
      displayName: first.displayName,
      provisional: true,
      message: 'New retry timed out'
    })
    expect(statuses()[0]).toBe('provisional')
  })

  it('keeps a retried row when the original batch errors afterwards', () => {
    const first = createWorkspaceCleanupRunReporter(store().startRun([candidates[0]]))
    act(() => first.onRowFailed(failure(0)))
    act(() => {
      store().beginRowRetry(candidates[0])
    })
    act(() => first.onError(new Error('late')))
    expect(statuses()).toEqual(['deleting'])
  })

  it('fails only the batch rows that never reported', () => {
    const reporter = createWorkspaceCleanupRunReporter(store().startRun(candidates))
    const [a, b] = [candidates[0], candidates[1]]
    const partial = createWorkspaceCleanupRunReporter({
      runId: run().id,
      attempts: new Map([[identity(0), 1]])
    })
    act(() => {
      reporter.onRowStarted(b)
      partial.onResult(result([]))
    })
    expect(statuses()).toEqual(['failed', 'deleting', 'waiting'])
    expect(a).toBeDefined()
  })
})

describe('WorkspaceCleanupRunCard', () => {
  it('shows nothing without a run and steps aside while the dialog is open', () => {
    const { container } = render(<WorkspaceCleanupRunCard />)
    expect(container.firstChild).toBeNull()
    act(() => {
      store().startRun(candidates)
      useAppStore.setState({ activeModal: 'workspace-cleanup' })
    })
    expect(container.firstChild).toBeNull()
  })

  it('has Show but no dismiss while running, and its status line does not tick', () => {
    const reporter = createWorkspaceCleanupRunReporter(store().startRun(candidates))
    render(<WorkspaceCleanupRunCard />)
    expect(screen.getAllByRole('button')).toHaveLength(1)
    const before = screen.getByRole('status').textContent
    act(() => reporter.onRowRemoved(candidates[0]))
    expect(screen.getByRole('status').textContent).toBe(before)
  })

  it('stays when finished until dismissed; Show reopens the dialog on the run', () => {
    const reporter = createWorkspaceCleanupRunReporter(store().startRun(candidates))
    act(() => {
      reporter.onResult(result([0, 1], [failure(2)]))
    })
    render(<WorkspaceCleanupRunCard />)
    fireEvent.click(screen.getAllByRole('button')[1])
    expect(useAppStore.getState().activeModal).toBe('workspace-cleanup')
    expect(useAppStore.getState().modalData.workspaceCleanupView).toBe('run')

    act(() => useAppStore.setState({ activeModal: 'none' }))
    fireEvent.click(screen.getAllByRole('button')[0])
    expect(store().run).toBeNull()
  })
})
