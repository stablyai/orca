import { describe, expect, it } from 'vitest'
import {
  getWorkspaceCleanupGitLabel,
  getWorkspaceCleanupGitState,
  sortWorkspaceCleanupCandidates
} from './workspace-cleanup-filter-sort'
import {
  formatGitStatus,
  getCandidateFactStatuses,
  getDirtyGitLabel
} from './workspace-cleanup-candidate-row-data'
import { getWorkspaceCleanupGitStateLabel } from './workspace-cleanup-facet-labels'
import { makeFacetCandidate, FACET_NOW } from './workspace-cleanup-facet.test.fixture'

/** A squash merge: clean tree, commits Git still counts as ahead of the upstream. */
const merged = makeFacetCandidate({
  reasons: ['merged'],
  git: { clean: true, upstreamAhead: 3, upstreamBehind: 0, merged: true, checkedAt: FACET_NOW }
})
const unmerged = makeFacetCandidate({
  worktreeId: 'repo-1::/repo/beta',
  path: '/repo/beta',
  reasons: ['idle-clean'],
  git: { clean: true, upstreamAhead: 3, upstreamBehind: 0, merged: false, checkedAt: FACET_NOW }
})
const unprobed = makeFacetCandidate({
  worktreeId: 'repo-1::/repo/gamma',
  path: '/repo/gamma',
  reasons: ['idle-clean'],
  git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, merged: null, checkedAt: FACET_NOW }
})

describe('merged workspace presentation', () => {
  it('reports the git state as merged, not unpushed', () => {
    // Why: a squash merge leaves local-only commit ids behind, so the ahead
    // count is nonzero on exactly the workspaces that are safest to retire.
    expect(getWorkspaceCleanupGitState(merged)).toBe('merged')
    expect(getWorkspaceCleanupGitLabel(merged)).toBe('Merged')
  })

  it('treats an unproven merge as not merged', () => {
    expect(getWorkspaceCleanupGitState(unprobed)).not.toBe('merged')
    expect(getWorkspaceCleanupGitState(unmerged)).toBe('unpushed')
  })

  it('names the merged facet after the proof it rests on', () => {
    expect(getWorkspaceCleanupGitStateLabel('merged')).toBe('Merged into base')
  })

  it('names the row detail chip too, instead of falling through to unknown', () => {
    // Why: the switch has a catch-all "Git unknown" default, so a state missing
    // a case reads as unprobed rather than merged — caught by rendering the row.
    expect(formatGitStatus(merged)).toBe('Merged into base')
  })

  it('drops the unpushed warning chip for a merged workspace', () => {
    expect(getDirtyGitLabel(merged)).toBeNull()
  })

  it('keeps the uncommitted warning chip when a merged workspace is dirty', () => {
    const dirtyMerged = makeFacetCandidate({
      git: { clean: false, upstreamAhead: 0, upstreamBehind: 0, merged: true, checkedAt: FACET_NOW }
    })

    expect(getDirtyGitLabel(dirtyMerged)).not.toBeNull()
  })

  it('reports the merge as the reason the workspace is suggested', () => {
    expect(getCandidateFactStatuses(merged).map((status) => status.label)).toContain('Merged')
  })

  it('prefers the merge over the archived flag the user set by hand', () => {
    const archivedAndMerged = makeFacetCandidate({
      reasons: ['archived', 'merged'],
      git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, merged: true, checkedAt: FACET_NOW }
    })

    expect(getCandidateFactStatuses(archivedAndMerged).map((status) => status.label)).toContain(
      'Merged'
    )
  })

  it('ranks merged as the safest git state, ahead of clean', () => {
    // Why: the git rank is a risk scale — clean < unknown < dirty < unpushed —
    // and the default ascending sort puts the safest row first. A merged branch
    // is safer than merely clean; ranking it above unpushed would call it the
    // riskiest row instead.
    const sorted = sortWorkspaceCleanupCandidates([unmerged, unprobed, merged], 'git', 'asc')

    expect(sorted[0].worktreeId).toBe(merged.worktreeId)
  })

  it('mirrors that order when the user reverses the sort', () => {
    const sorted = sortWorkspaceCleanupCandidates([merged, unprobed, unmerged], 'git', 'desc')

    expect(sorted.at(-1)?.worktreeId).toBe(merged.worktreeId)
  })
})
