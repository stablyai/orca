// @vitest-environment happy-dom

import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'
import { useWorkspaceCleanupGitEvidence } from './use-workspace-cleanup-git-evidence'

const holders = vi.hoisted(() => ({ cancelScan: vi.fn(), scan: vi.fn() }))

type PendingScan = {
  worktreeIds: string[]
  onProgress?: (progress: WorkspaceCleanupScanProgress) => void
  resolve: (result: WorkspaceCleanupScanResult) => void
}

function deferredCandidate(worktreeId: string) {
  return makeFacetCandidate({
    worktreeId,
    git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
  })
}

describe('useWorkspaceCleanupGitEvidence', () => {
  let pending: PendingScan[]

  beforeEach(() => {
    pending = []
    holders.scan.mockReset()
    holders.cancelScan.mockReset().mockResolvedValue(true)
    holders.scan.mockImplementation(
      (
        { worktreeIds }: { worktreeIds: string[] },
        onProgress?: (progress: WorkspaceCleanupScanProgress) => void
      ) => {
        return new Promise<WorkspaceCleanupScanResult>((resolve) => {
          pending.push({ worktreeIds, onProgress, resolve })
        })
      }
    )
    ;(window as unknown as { api: unknown }).api = {
      workspaceCleanup: {
        cancelScan: holders.cancelScan,
        scan: holders.scan
      }
    }
  })

  it('bounds restarted passes and isolates them from stale settlements', async () => {
    const candidates = ['a', 'b', 'c', 'd', 'e', 'f'].map(deferredCandidate)
    const view = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useWorkspaceCleanupGitEvidence({ enabled, candidates, scannedAt: 1 }),
      { initialProps: { enabled: true } }
    )

    await waitFor(() => expect(view.result.current.totalCount).toBe(6))
    expect(view.result.current.pendingWorktreeIds.size).toBe(6)
    expect(holders.scan).toHaveBeenCalledTimes(1)
    expect(holders.scan).toHaveBeenCalledWith(
      {
        worktreeIds: ['a', 'b', 'c', 'd', 'e', 'f'],
        scanId: expect.any(String)
      },
      expect.any(Function)
    )

    view.rerender({ enabled: false })
    await waitFor(() => expect(view.result.current.pendingWorktreeIds.size).toBe(0))
    expect(holders.cancelScan).toHaveBeenCalledWith(expect.any(String))
    view.rerender({ enabled: true })
    await waitFor(() => expect(view.result.current.pendingWorktreeIds.size).toBe(6))
    expect(holders.scan).toHaveBeenCalledTimes(1)
    expect(view.result.current.pendingWorktreeIds.size).toBe(6)

    await act(async () => {
      pending[0]?.resolve({
        scannedAt: 2,
        candidates: [makeFacetCandidate({ worktreeId: 'a' })],
        errors: []
      })
    })
    await waitFor(() => expect(holders.scan).toHaveBeenCalledTimes(2))
    expect(view.result.current.pendingWorktreeIds.size).toBe(6)
    expect(view.result.current.evidenceByIdentity.size).toBe(0)

    await act(async () => {
      pending[1]?.onProgress?.({
        scanId: 'batch-2',
        scannedAt: 3,
        scannedWorktreeCount: 1,
        totalWorktreeCount: 6,
        candidates: [makeFacetCandidate({ worktreeId: 'a' })],
        errors: [],
        candidateMode: 'append'
      })
    })
    await waitFor(() => expect(view.result.current.evidenceByIdentity.size).toBe(1))
    expect(view.result.current.pendingWorktreeIds.size).toBe(5)
  })

  it('chunks dispatches at the shared target batch limit so no queued id is dropped', async () => {
    const first = Array.from({ length: 300 }, (_, i) => deferredCandidate(`a${i}`))
    const grown = [...first, ...Array.from({ length: 600 }, (_, i) => deferredCandidate(`b${i}`))]
    const view = renderHook(
      ({ candidates }: { candidates: ReturnType<typeof deferredCandidate>[] }) =>
        useWorkspaceCleanupGitEvidence({ enabled: true, candidates, scannedAt: 1 }),
      { initialProps: { candidates: first } }
    )

    await waitFor(() => expect(holders.scan).toHaveBeenCalledTimes(1))
    expect(pending[0]?.worktreeIds).toHaveLength(300)

    // 600 more ids queue while the first request is in flight.
    view.rerender({ candidates: grown })
    await waitFor(() => expect(view.result.current.totalCount).toBe(900))
    expect(holders.scan).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending[0]?.resolve({ scannedAt: 1, candidates: [], errors: [] })
    })
    await waitFor(() => expect(holders.scan).toHaveBeenCalledTimes(2))
    expect(pending[1]?.worktreeIds).toHaveLength(500)

    await act(async () => {
      pending[1]?.resolve({ scannedAt: 1, candidates: [], errors: [] })
    })
    await waitFor(() => expect(holders.scan).toHaveBeenCalledTimes(3))
    expect(pending[2]?.worktreeIds).toHaveLength(100)

    const dispatched = pending.flatMap((request) => request.worktreeIds)
    expect(new Set(dispatched).size).toBe(900)
  })

  it('keeps state identity stable when a progress frame changes nothing', async () => {
    const candidates = [deferredCandidate('a')]
    const view = renderHook(() =>
      useWorkspaceCleanupGitEvidence({ enabled: true, candidates, scannedAt: 1 })
    )
    await waitFor(() => expect(holders.scan).toHaveBeenCalledTimes(1))
    const before = view.result.current

    await act(async () => {
      pending[0]?.onProgress?.({
        scanId: 'noop',
        scannedAt: 1,
        scannedWorktreeCount: 0,
        totalWorktreeCount: 1,
        candidates: [makeFacetCandidate({ worktreeId: 'unrelated' })],
        errors: [],
        candidateMode: 'append'
      })
    })
    expect(view.result.current).toBe(before)
  })

  it('restarts evidence collection when the settled scan snapshot changes', async () => {
    const candidates = [deferredCandidate('a')]
    const view = renderHook(
      ({ scannedAt }: { scannedAt: number }) =>
        useWorkspaceCleanupGitEvidence({ enabled: true, candidates, scannedAt }),
      { initialProps: { scannedAt: 1 } }
    )

    await waitFor(() => expect(holders.scan).toHaveBeenCalledTimes(1))
    view.rerender({ scannedAt: 2 })
    expect(holders.scan).toHaveBeenCalledTimes(1)

    await act(async () => {
      pending[0]?.resolve({
        scannedAt: 1,
        candidates: [makeFacetCandidate({ worktreeId: 'a' })],
        errors: []
      })
    })
    await waitFor(() => expect(holders.scan).toHaveBeenCalledTimes(2))
    expect(view.result.current.evidenceByIdentity.size).toBe(0)
    expect(view.result.current.pendingWorktreeIds).toEqual(new Set(['a']))

    await act(async () => {
      pending[1]?.resolve({
        scannedAt: 2,
        candidates: [makeFacetCandidate({ worktreeId: 'a' })],
        errors: []
      })
    })
    await waitFor(() => expect(view.result.current.evidenceByIdentity.size).toBe(1))
  })
})
