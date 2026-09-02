import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { describe, expect, it } from 'vitest'
import { createDefaultWorkspaceCleanupFilterState } from '../../../../shared/workspace-cleanup-filter-model'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'
import {
  applyWorkspaceCleanupGitEvidence,
  hasWorkspaceCleanupGitEvidence,
  needsWorkspaceCleanupGitEvidence,
  selectWorkspaceCleanupGitEvidenceTargets
} from './workspace-cleanup-git-evidence'

const CLEAN_SORT = { field: 'name', direction: 'asc' } as const

function deferredCandidate(worktreeId: string) {
  return makeFacetCandidate({
    worktreeId,
    git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
  })
}

describe('needsWorkspaceCleanupGitEvidence', () => {
  it('stays off for a filter and sort that never read git', () => {
    expect(
      needsWorkspaceCleanupGitEvidence(createDefaultWorkspaceCleanupFilterState(), CLEAN_SORT)
    ).toBe(false)
  })

  it.each([
    [
      'git state',
      (f: ReturnType<typeof createDefaultWorkspaceCleanupFilterState>) => {
        f.git.states = ['dirty']
      }
    ],
    [
      'ahead threshold',
      (f: ReturnType<typeof createDefaultWorkspaceCleanupFilterState>) => {
        f.git.minAhead = 1
      }
    ],
    [
      'behind threshold',
      (f: ReturnType<typeof createDefaultWorkspaceCleanupFilterState>) => {
        f.git.minBehind = 1
      }
    ],
    [
      'git-derived blocker',
      (f: ReturnType<typeof createDefaultWorkspaceCleanupFilterState>) => {
        f.safety.blockers = ['unpushed-commits']
      }
    ]
  ])('turns on for a %s filter', (_label, mutate) => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    mutate(filters)
    expect(needsWorkspaceCleanupGitEvidence(filters, CLEAN_SORT)).toBe(true)
  })

  it.each(['git', 'ahead', 'behind'] as const)('turns on for the %s sort', (field) => {
    expect(
      needsWorkspaceCleanupGitEvidence(createDefaultWorkspaceCleanupFilterState(), {
        field,
        direction: 'asc'
      })
    ).toBe(true)
  })

  it('ignores a blocker filter that does not depend on git', () => {
    const filters = createDefaultWorkspaceCleanupFilterState()
    filters.safety.blockers = ['pinned']
    expect(needsWorkspaceCleanupGitEvidence(filters, CLEAN_SORT)).toBe(false)
  })
})

describe('selectWorkspaceCleanupGitEvidenceTargets', () => {
  it('only targets rows the host deferred', () => {
    const targets = selectWorkspaceCleanupGitEvidenceTargets([
      deferredCandidate('a'),
      makeFacetCandidate({ worktreeId: 'b' })
    ])
    expect(targets).toEqual(['a'])
    expect(hasWorkspaceCleanupGitEvidence(makeFacetCandidate({ worktreeId: 'b' }))).toBe(true)
  })

  it('skips rows already attempted and caps the batch', () => {
    const candidates = ['a', 'b', 'c'].map(deferredCandidate)
    expect(
      selectWorkspaceCleanupGitEvidenceTargets(candidates, {
        resolvedWorktreeIds: new Set(['a'])
      })
    ).toEqual(['b', 'c'])
    expect(selectWorkspaceCleanupGitEvidenceTargets(candidates, { maxTargets: 2 })).toEqual([
      'a',
      'b'
    ])
  })
})

describe('applyWorkspaceCleanupGitEvidence', () => {
  it('replaces the deferred row with the focused re-scan result', () => {
    const deferred = deferredCandidate('a')
    const refreshed = makeFacetCandidate({
      worktreeId: 'a',
      git: { clean: false, upstreamAhead: 2, upstreamBehind: 0, checkedAt: 5 }
    })
    const [row] = applyWorkspaceCleanupGitEvidence(
      [deferred],
      new Map([[getWorkspaceCleanupCandidateIdentity(refreshed), refreshed]])
    )
    expect(row.git.clean).toBe(false)
    expect(row.git.checkedAt).toBe(5)
  })

  it("never applies one host's git evidence to another host's same-id row", () => {
    // STA-4343: a dirty remote row must not mark the local same-id row dirty
    // (or vice versa) — the evidence index is keyed by host, not by id.
    const localRow = { ...deferredCandidate('a'), executionHostId: 'local' as const }
    const remoteEvidence = {
      ...makeFacetCandidate({
        worktreeId: 'a',
        blockers: ['dirty-files'],
        git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 5 }
      }),
      connectionId: 'ssh-1',
      executionHostId: 'ssh:ssh-1' as const
    }
    const [row] = applyWorkspaceCleanupGitEvidence(
      [localRow],
      new Map([[getWorkspaceCleanupCandidateIdentity(remoteEvidence), remoteEvidence]])
    )
    expect(row.git).toEqual(localRow.git)
    expect(row.blockers).not.toContain('dirty-files')
  })

  it('returns the input untouched when nothing was re-scanned', () => {
    const candidates = [deferredCandidate('a')]
    expect(applyWorkspaceCleanupGitEvidence(candidates, new Map())).toBe(candidates)
  })

  it('merges only git facts into the current broad-scan row', () => {
    const current = deferredCandidate('a')
    current.displayName = 'current name'
    current.blockers = ['dismissed']
    current.fingerprint = 'current-fingerprint'
    const refreshed = makeFacetCandidate({
      worktreeId: 'a',
      displayName: 'stale name',
      blockers: ['dirty-files'],
      fingerprint: 'focused-fingerprint',
      git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 5 }
    })

    const [row] = applyWorkspaceCleanupGitEvidence(
      [current],
      new Map([[getWorkspaceCleanupCandidateIdentity(refreshed), refreshed]])
    )

    expect(row.displayName).toBe('current name')
    expect(row.fingerprint).toBe('current-fingerprint')
    expect(row.blockers).toEqual(expect.arrayContaining(['dismissed', 'dirty-files']))
    expect(row.git).toEqual(refreshed.git)
  })

  it('keeps newer broad-scan git evidence', () => {
    const current = makeFacetCandidate({
      worktreeId: 'a',
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 10 }
    })
    const older = makeFacetCandidate({
      worktreeId: 'a',
      git: { clean: false, upstreamAhead: 2, upstreamBehind: 0, checkedAt: 5 }
    })

    expect(applyWorkspaceCleanupGitEvidence([current], new Map([['a', older]]))[0]).toBe(current)
  })
})
