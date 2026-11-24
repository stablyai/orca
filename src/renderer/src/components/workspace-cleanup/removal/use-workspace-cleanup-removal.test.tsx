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
  it('retries a failed row while the batch still owns another deletion', async () => {
    const failed = makeCandidate({
      executionHostId: 'local',
      worktreeId: 'repo-1::/repo/preflight-failure',
      path: '/repo/preflight-failure'
    })
    const sibling = makeCandidate({
      executionHostId: 'local',
      worktreeId: 'repo-1::/repo/waiting',
      path: '/repo/waiting'
    })
    const failedIdentity = getWorkspaceCleanupCandidateIdentity(failed)
    useAppStore.setState({
      removeWorkspaceCleanupCandidates: ([worktreeId], options) => {
        if (worktreeId === sibling.worktreeId) {
          return new Promise(() => {})
        }
        if (options?.unverifiedRemovalConsent) {
          return Promise.resolve({
            removedIds: [worktreeId],
            removedIdentities: [failedIdentity],
            failures: []
          })
        }
        return Promise.resolve({
          removedIds: [],
          removedIdentities: [],
          failures: [
            {
              worktreeId,
              executionHostId: 'local',
              displayName: failed.displayName,
              message: 'Git status could not be verified',
              canDeleteAnyway: true
            }
          ]
        })
      }
    })
    const { result } = renderHook(() =>
      useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
    )
    const status = (identity: string) =>
      useWorkspaceCleanupRunStore.getState().run?.rows.find((row) => row.identity === identity)
        ?.status

    act(() => result.current.confirmRemove([failed, sibling]))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(status(failedIdentity)).toBe('failed')
    expect(status(getWorkspaceCleanupCandidateIdentity(sibling))).toBe('deleting')

    act(() => result.current.confirmUnverifiedRemoval(failed))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(status(failedIdentity)).toBe('deleted')
    expect(status(getWorkspaceCleanupCandidateIdentity(sibling))).toBe('deleting')
  })

  it('guards a permanent retry against the busy marker for its own host', () => {
    const local = makeCandidate({
      executionHostId: 'local',
      worktreeId: 'repo-1::/repo/busy-twin',
      path: '/repo/busy-twin'
    })
    const remote = { ...local, executionHostId: 'ssh:workbench' } as const
    useAppStore
      .getState()
      .markWorktreesQueuedForDeletion([{ id: remote.worktreeId, hostId: remote.executionHostId }])
    useAppStore.setState({
      removeWorkspaceCleanupCandidates: () => new Promise(() => {})
    })
    const { result } = renderHook(() =>
      useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
    )

    act(() => result.current.confirmUnverifiedRemoval(remote))
    expect(useWorkspaceCleanupRunStore.getState().run).toBeNull()

    act(() => result.current.confirmUnverifiedRemoval(local))
    expect(useWorkspaceCleanupRunStore.getState().run?.rows[0]?.identity).toBe(
      getWorkspaceCleanupCandidateIdentity(local)
    )
  })

  it.each([
    { older: 'ordinary', newer: 'force' },
    { older: 'force', newer: 'ordinary' }
  ] as const)(
    'keeps the newer $newer error when the earlier $older removal fails late',
    async ({ older, newer }) => {
      const path = `/repo/${older}-first`
      const row = makeCandidate({ executionHostId: 'local', worktreeId: `repo-1::${path}`, path })
      const identity = getWorkspaceCleanupCandidateIdentity(row)
      const pending = Promise.withResolvers<WorkspaceCleanupRemoveResult>()
      const newerFailure = {
        worktreeId: row.worktreeId,
        executionHostId: row.executionHostId,
        displayName: row.displayName,
        message: 'Newer attempt could not delete the workspace',
        canDeleteAnyway: newer === 'ordinary'
      }
      useAppStore.setState({
        removeWorkspaceCleanupCandidates: vi
          .fn<() => Promise<WorkspaceCleanupRemoveResult>>()
          .mockReturnValueOnce(pending.promise)
          .mockResolvedValueOnce({
            removedIds: [],
            removedIdentities: [],
            failures: [newerFailure]
          })
      })
      const { result } = renderHook(() =>
        useWorkspaceCleanupRemoval({ onDeselect: () => {}, closeModal: () => {} })
      )
      const submit = (mode: 'ordinary' | 'force'): void => {
        if (mode === 'force') {
          result.current.confirmUnverifiedRemoval(row)
        } else {
          result.current.confirmRemove([row])
        }
      }

      act(() => submit(older))
      await act(() =>
        vi.advanceTimersByTimeAsync(UNRESOLVED_AFTER_MS + WORKSPACE_CLEANUP_PROVISIONAL_CEILING_MS)
      )
      act(() => useWorkspaceCleanupRunStore.getState().dismissRun())

      act(() => submit(newer))
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(result.current.rowFailures[identity]).toEqual(newerFailure)
      act(() => useWorkspaceCleanupRunStore.getState().dismissRun())

      pending.resolve({
        removedIds: [],
        removedIdentities: [],
        failures: [
          {
            ...newerFailure,
            message: 'Older failure',
            canDeleteAnyway: !newerFailure.canDeleteAnyway
          }
        ]
      })
      await act(() => vi.advanceTimersByTimeAsync(0))
      expect(result.current.rowFailures[identity]).toEqual(newerFailure)
    }
  )

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
