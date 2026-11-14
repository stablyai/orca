import { describe, expect, it } from 'vitest'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../../shared/workspace-cleanup/workspace-cleanup-host-identity'
import type { WorkspaceCleanupCandidate } from '../../../../../shared/workspace-cleanup/workspace-cleanup'
import { makeCandidate } from '../query/workspace-cleanup-candidate-state.test-fixture'
import {
  computeWorkspaceCleanupFacetList,
  createWorkspaceCleanupFacetListCache
} from '../query/workspace-cleanup-facet-row-caches'
import { applyWorkspaceCleanupGitEvidence } from './workspace-cleanup-git-evidence'

function unchecked(i: number): WorkspaceCleanupCandidate {
  return makeCandidate({
    worktreeId: `repo-1::/repo/w${i}`,
    displayName: `w${i}`,
    path: `/repo/w${i}`,
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: null }
  })
}

describe('applyWorkspaceCleanupGitEvidence identity', () => {
  it('reuses merged rows so streamed evidence only rebuilds the rows that changed', () => {
    const rows = Array.from({ length: 300 }, (_, i) => unchecked(i))
    const evidence = new Map<string, WorkspaceCleanupCandidate>()
    const sources = {
      worktreeById: new Map(),
      workspaceStatuses: [],
      sizeBytesByWorktreeId: new Map(),
      lastVisitedAtByWorktreeId: {},
      liveAgentStatusByWorktreeId: new Map(),
      reviewInfoByWorktreeId: new Map(),
      dismissedIdentities: new Set<string>()
    }
    const cache = createWorkspaceCleanupFacetListCache()
    let rebuilt = 0
    for (let start = 0; start < rows.length; start += 5) {
      for (const row of rows.slice(start, start + 5)) {
        evidence.set(getWorkspaceCleanupCandidateIdentity(row), {
          ...row,
          git: { clean: false, upstreamAhead: 1, upstreamBehind: 0, checkedAt: 2 }
        })
      }
      const applied = applyWorkspaceCleanupGitEvidence(rows, evidence)
      rebuilt += applied.filter((candidate) => !cache.byCandidate.has(candidate)).length
      computeWorkspaceCleanupFacetList({ candidates: applied, sources: sources as never, cache })
    }
    // Each row builds once unmerged and once when its own evidence lands (~600 total). Re-merging
    // every evidenced row per publish rebuilt ~9.4k of 18k facets for the same stream.
    expect(rebuilt).toBeLessThanOrEqual(rows.length * 2)
  })

  it('returns the same merged row until its evidence entry changes', () => {
    const [row] = [unchecked(1)]
    const first = new Map([
      [
        getWorkspaceCleanupCandidateIdentity(row),
        { ...row, git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 2 } }
      ]
    ])
    const a = applyWorkspaceCleanupGitEvidence([row], first)[0]
    expect(applyWorkspaceCleanupGitEvidence([row], new Map(first))[0]).toBe(a)
    const next = new Map(first)
    next.set(getWorkspaceCleanupCandidateIdentity(row), {
      ...row,
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 3 }
    })
    expect(applyWorkspaceCleanupGitEvidence([row], next)[0]).not.toBe(a)
  })
})
