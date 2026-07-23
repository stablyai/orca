import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '../types'
import {
  enrichWorkspaceCleanupCandidates,
  WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY
} from './workspace-cleanup'
import { makeCandidate, makeState } from './workspace-cleanup-slice-test-harness'

describe('workspace cleanup enrichment concurrency', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('preserves order while bounding terminal probes across a large scan', async () => {
    const candidateCount = 1_000
    const candidates = Array.from({ length: candidateCount }, (_, index) =>
      makeCandidate({
        worktreeId: `repo-${index}::/workspace/${index}`,
        repoId: `repo-${index}`,
        path: `/workspace/${index}`
      })
    )
    const tabsByWorktree = Object.fromEntries(
      candidates.map((candidate, index) => [
        candidate.worktreeId,
        [{ id: `tab-${index}`, title: 'shell' }]
      ])
    ) as AppState['tabsByWorktree']
    const ptyIdsByTabId = Object.fromEntries(
      candidates.map((_, index) => [`tab-${index}`, [`pty-${index}`]])
    )
    let activeProbes = 0
    let peakProbes = 0

    vi.stubGlobal('window', {
      api: {
        pty: {
          hasChildProcesses: vi.fn(async () => {
            activeProbes += 1
            peakProbes = Math.max(peakProbes, activeProbes)
            await Promise.resolve()
            activeProbes -= 1
            return false
          }),
          getForegroundProcess: vi.fn().mockResolvedValue(null)
        }
      }
    })

    const enriched = await enrichWorkspaceCleanupCandidates(
      candidates,
      makeState({ tabsByWorktree, ptyIdsByTabId }),
      { applyDismissals: false }
    )

    expect(peakProbes).toBe(WORKSPACE_CLEANUP_ENRICHMENT_CONCURRENCY)
    expect(enriched.map((candidate) => candidate.worktreeId)).toEqual(
      candidates.map((candidate) => candidate.worktreeId)
    )
  })
})
