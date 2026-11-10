import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '../../types'
import type {
  WorkspaceCleanupScanArgs,
  WorkspaceCleanupScanProgress,
  WorkspaceCleanupScanResult
} from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY } from './workspace-cleanup-candidate-enrichment'
import {
  NOW,
  createCleanupTestStore,
  deferred,
  installWorkspaceCleanupApi,
  makeCandidate
} from './workspace-cleanup-slice-test-harness'

function makePerformanceCandidate(index: number, fingerprintSuffix = 'stream') {
  return makeCandidate({
    worktreeId: `repo-${index}::/workspace/${index}`,
    repoId: `repo-${index}`,
    displayName: `workspace-${index}`,
    path: `/workspace/${index}`,
    fingerprint: `fingerprint-${index}-${fingerprintSuffix}`
  })
}

describe('workspace cleanup enrichment performance', () => {
  it('drains streamed enrichment before projecting the final scan', async () => {
    const candidateCount = WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY + 3
    const candidates = Array.from({ length: candidateCount }, (_, index) =>
      makePerformanceCandidate(index)
    )
    const tabsByWorktree = Object.fromEntries(
      candidates.map((candidate, index) => [
        candidate.worktreeId,
        [{ id: `tab-overlap-${index}`, title: 'shell' }]
      ])
    ) as AppState['tabsByWorktree']
    const ptyIdsByTabId = Object.fromEntries(
      candidates.map((_, index) => [`tab-overlap-${index}`, [`pty-overlap-${index}`]])
    )
    const pending = deferred<WorkspaceCleanupScanResult>()
    let onProgress: ((progress: WorkspaceCleanupScanProgress) => void) | undefined
    installWorkspaceCleanupApi(
      vi.fn(
        (
          _args?: WorkspaceCleanupScanArgs,
          progressCallback?: (progress: WorkspaceCleanupScanProgress) => void
        ) => {
          onProgress = progressCallback
          return pending.promise
        }
      )
    )

    const probeGate = deferred<void>()
    let active = 0
    let peak = 0
    const hasChildProcesses = vi.fn(async () => {
      active += 1
      peak = Math.max(peak, active)
      await probeGate.promise
      active -= 1
      return false
    })
    ;(
      globalThis.window as unknown as {
        api: {
          pty: {
            hasChildProcesses: typeof hasChildProcesses
            getForegroundProcess: ReturnType<typeof vi.fn>
          }
        }
      }
    ).api.pty = {
      hasChildProcesses,
      getForegroundProcess: vi.fn().mockResolvedValue('zsh')
    }
    const store = createCleanupTestStore()
    store.setState({ tabsByWorktree, ptyIdsByTabId } as Partial<AppState>)

    const scanPromise = store.getState().scanWorkspaceCleanup()
    onProgress?.({
      scanId: 'overlapping-final-scan',
      scannedAt: NOW,
      scannedWorktreeCount: candidateCount,
      totalWorktreeCount: candidateCount,
      candidates,
      errors: [],
      candidateMode: 'append'
    })
    pending.resolve({ scannedAt: NOW, candidates, errors: [] })

    await vi.waitFor(() => {
      expect(active).toBeGreaterThanOrEqual(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(peak).toBe(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)

    probeGate.resolve()
    await scanPromise

    expect(hasChildProcesses).toHaveBeenCalledTimes(candidateCount)
  })
})
