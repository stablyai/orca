import { describe, expect, it, vi } from 'vitest'

import type {
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
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
})
