import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import type {
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../shared/workspace-cleanup'
import {
  NOW,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

const CACHED_AT = NOW - 60 * 60 * 1000

function makeCachedScan(): WorkspaceCleanupScanResult {
  return {
    scannedAt: CACHED_AT,
    candidates: [
      makeCandidate({ worktreeId: 'repo1::/tmp/alpha', displayName: 'alpha' }),
      makeCandidate({ worktreeId: 'repo1::/tmp/beta', displayName: 'beta' })
    ],
    errors: []
  }
}

describe('workspace cleanup cache hydration', () => {
  it('hydrates an empty slice from the persisted snapshot', async () => {
    const scan = vi.fn()
    const getCachedScan = vi.fn().mockResolvedValue(makeCachedScan())
    installWorkspaceCleanupApi(scan, getCachedScan)
    const store = createCleanupTestStore()

    await expect(store.getState().hydrateWorkspaceCleanupFromCache()).resolves.toBe(true)

    expect(scan).not.toHaveBeenCalled()
    expect(store.getState().workspaceCleanupScan?.scannedAt).toBe(CACHED_AT)
    expect(
      store.getState().workspaceCleanupScan?.candidates.map((candidate) => candidate.worktreeId)
    ).toEqual(['repo1::/tmp/alpha', 'repo1::/tmp/beta'])
  })

  it('never clobbers live scan data with the snapshot', async () => {
    const getCachedScan = vi.fn().mockResolvedValue(makeCachedScan())
    installWorkspaceCleanupApi(vi.fn(), getCachedScan)
    const store = createCleanupTestStore()
    const live = { scannedAt: NOW, candidates: [makeCandidate()], errors: [] }
    store.setState({ workspaceCleanupScan: live } as Partial<AppState>)

    await expect(store.getState().hydrateWorkspaceCleanupFromCache()).resolves.toBe(false)

    expect(getCachedScan).not.toHaveBeenCalled()
    expect(store.getState().workspaceCleanupScan).toBe(live)
  })

  it('bails when a broad scan starts while the cache read is in flight', async () => {
    const cacheRead = deferred<WorkspaceCleanupScanResult>()
    const broadScan = deferred<WorkspaceCleanupScanResult>()
    const scan = vi.fn().mockReturnValue(broadScan.promise)
    installWorkspaceCleanupApi(scan, vi.fn().mockReturnValue(cacheRead.promise))
    const store = createCleanupTestStore()

    const hydration = store.getState().hydrateWorkspaceCleanupFromCache()
    const scanPromise = store.getState().scanWorkspaceCleanup()
    cacheRead.resolve(makeCachedScan())

    await expect(hydration).resolves.toBe(false)
    expect(store.getState().workspaceCleanupScan).toBeNull()

    broadScan.resolve({ scannedAt: NOW, candidates: [], errors: [] })
    await scanPromise
    expect(store.getState().workspaceCleanupScan?.scannedAt).toBe(NOW)
  })

  it('reconciles a refresh into the hydrated snapshot instead of clearing it', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(makeCachedScan()))
    const store = createCleanupTestStore()
    await store.getState().hydrateWorkspaceCleanupFromCache()

    const scanPromise = store.getState().scanWorkspaceCleanup()
    const refreshedAlpha = makeCandidate({
      worktreeId: 'repo1::/tmp/alpha',
      displayName: 'alpha',
      lastActivityAt: NOW - 1000,
      fingerprint: 'fingerprint-alpha-2'
    })
    const gamma = makeCandidate({ worktreeId: 'repo1::/tmp/gamma', displayName: 'gamma' })
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 2,
      totalWorktreeCount: 3,
      candidates: [refreshedAlpha, gamma],
      errors: [],
      candidateMode: 'append'
    })

    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(2)
    })
    const streaming = store.getState().workspaceCleanupScan
    // Update in place, keep unseen snapshot rows, append new — never clear.
    expect(streaming?.candidates.map((candidate) => candidate.worktreeId)).toEqual([
      'repo1::/tmp/alpha',
      'repo1::/tmp/beta',
      'repo1::/tmp/gamma'
    ])
    expect(streaming?.candidates[0]?.fingerprint).toBe('fingerprint-alpha-2')
    // The presented "as of" time stays the snapshot's until the scan settles.
    expect(streaming?.scannedAt).toBe(CACHED_AT)

    pending.resolve({ scannedAt: NOW, candidates: [refreshedAlpha, gamma], errors: [] })
    await scanPromise

    const settled = store.getState().workspaceCleanupScan
    expect(settled?.scannedAt).toBe(NOW)
    // beta vanished from the final result, so only the settle removes it.
    expect(settled?.candidates.map((candidate) => candidate.worktreeId)).toEqual([
      'repo1::/tmp/alpha',
      'repo1::/tmp/gamma'
    ])
  })

  it('keeps one scan streaming across a dialog close and reopen', async () => {
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    const scan = vi.fn((_args, progressCallback) => {
      onProgress = progressCallback
      return pending.promise
    })
    installWorkspaceCleanupApi(scan, vi.fn().mockResolvedValue(null))
    const store = createCleanupTestStore()

    const first = store.getState().scanWorkspaceCleanup()
    const early = [
      makeCandidate({ worktreeId: 'repo1::/tmp/one' }),
      makeCandidate({ worktreeId: 'repo1::/tmp/two' })
    ]
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 2,
      totalWorktreeCount: 5,
      candidates: early,
      errors: [],
      candidateMode: 'append'
    })
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(2)
    })

    // Dialog closes at 40% and reopens: reopening adopts the in-flight scan.
    // The dialog joins via another scan call, which must not restart anything.
    const rejoined = store.getState().scanWorkspaceCleanup()
    expect(scan).toHaveBeenCalledTimes(1)

    const late = [
      makeCandidate({ worktreeId: 'repo1::/tmp/three' }),
      makeCandidate({ worktreeId: 'repo1::/tmp/four' }),
      makeCandidate({ worktreeId: 'repo1::/tmp/five' })
    ]
    onProgress?.({
      scanId: 'scan-1',
      scannedAt: NOW,
      scannedWorktreeCount: 5,
      totalWorktreeCount: 5,
      candidates: late,
      errors: [],
      candidateMode: 'append'
    })
    await vi.waitFor(() => {
      expect(store.getState().workspaceCleanupProgress?.scannedWorktreeCount).toBe(5)
    })

    pending.resolve({ scannedAt: NOW, candidates: [...early, ...late], errors: [] })
    await Promise.all([first, rejoined])

    expect(store.getState().workspaceCleanupLoading).toBe(false)
    expect(
      store.getState().workspaceCleanupScan?.candidates.map((candidate) => candidate.worktreeId)
    ).toEqual([
      'repo1::/tmp/one',
      'repo1::/tmp/two',
      'repo1::/tmp/three',
      'repo1::/tmp/four',
      'repo1::/tmp/five'
    ])
  })
})
