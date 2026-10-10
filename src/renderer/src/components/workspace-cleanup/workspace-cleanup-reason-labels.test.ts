import { describe, expect, it } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import { buildWorkspaceCleanupFacets } from './workspace-cleanup-facets'
import { makeFacetCandidate } from './workspace-cleanup-facet.test.fixture'
import { applyWorkspaceCleanupGitEvidence } from './workspace-cleanup-git-evidence'
import { getCandidateFactStatuses } from './workspace-cleanup-candidate-row-data'
import {
  getWorkspaceCleanupReasonChips,
  getWorkspaceCleanupReasonLabel
} from './workspace-cleanup-reason-labels'

describe('workspace cleanup reason chips', () => {
  it('labels each new signal with a short chip and a precise description', () => {
    const chips = getWorkspaceCleanupReasonChips({
      reasons: ['idle-clean', 'prunable', 'merged', 'stale-agent'],
      mergedBaseRef: 'origin/main'
    })

    expect(chips.map((chip) => chip.label)).toEqual(['Merged', 'Stale agent', 'Prunable'])
    expect(chips[0]?.description).toBe('All branch commits are in origin/main')
  })

  it('reuses a merged provider review for squash merges ancestry cannot see', () => {
    const chips = getWorkspaceCleanupReasonChips({ reasons: ['idle-clean'] }, { state: 'merged' })

    expect(chips).toEqual([
      { reason: 'merged', label: 'Merged', description: 'Its linked review was merged' }
    ])
    expect(getWorkspaceCleanupReasonChips({ reasons: [] }, { state: 'open' })).toEqual([])
  })

  it('labels a stray folder as unregistered', () => {
    expect(getWorkspaceCleanupReasonChips({ reasons: ['unregistered'] })[0]?.label).toBe(
      'Unregistered'
    )
  })
})

describe('unknown cleanup reasons from a newer host', () => {
  const fromNewerHost = (): WorkspaceCleanupCandidate => ({
    ...makeFacetCandidate(),
    ...JSON.parse(JSON.stringify({ reasons: ['future-signal', 'archived'] }))
  })

  it('renders no chip, keeps existing statuses, and stays filterable', () => {
    const candidate = fromNewerHost()

    expect(getWorkspaceCleanupReasonLabel('future-signal')).toBeNull()
    expect(getWorkspaceCleanupReasonChips(candidate)).toEqual([])
    expect(getCandidateFactStatuses(candidate).map((status) => status.label)).toEqual(['Archived'])
    const facets = buildWorkspaceCleanupFacets(candidate)
    expect(facets.isArchived).toBe(true)
    expect(facets.searchText).toContain('future-signal')
  })
})

describe('merged evidence from a focused git re-scan', () => {
  it('replaces the deferred row reason and base with the fresh evidence', () => {
    const deferred = makeFacetCandidate({
      reasons: ['idle-clean'],
      git: { clean: null, upstreamAhead: null, upstreamBehind: null, checkedAt: null }
    })
    const evidence = makeFacetCandidate({
      reasons: ['idle-clean', 'merged'],
      mergedBaseRef: 'origin/main',
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 10 }
    })

    const [merged] = applyWorkspaceCleanupGitEvidence(
      [deferred],
      new Map([[getWorkspaceCleanupCandidateIdentity(evidence), evidence]])
    )
    expect(merged?.reasons).toEqual(['idle-clean', 'merged'])
    expect(merged?.mergedBaseRef).toBe('origin/main')

    const newer = makeFacetCandidate({
      reasons: ['idle-clean'],
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 20 }
    })
    const staleMerged = makeFacetCandidate({
      reasons: ['idle-clean', 'merged'],
      mergedBaseRef: 'origin/main',
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 5 }
    })
    const [unmerged] = applyWorkspaceCleanupGitEvidence(
      [staleMerged],
      new Map([[getWorkspaceCleanupCandidateIdentity(newer), newer]])
    )
    expect(unmerged?.reasons).toEqual(['idle-clean'])
    expect(unmerged?.mergedBaseRef).toBeUndefined()
  })
})
