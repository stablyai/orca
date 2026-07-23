import { describe, expect, it } from 'vitest'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { sortWorkspaceCleanupCandidates } from './workspace-cleanup-filter-sort'

function candidate(overrides: Partial<WorkspaceCleanupCandidate>): WorkspaceCleanupCandidate {
  return {
    worktreeId: 'wt',
    repoId: 'repo',
    repoName: 'Repo',
    connectionId: null,
    displayName: 'Workspace',
    branch: 'feature',
    path: '/workspace',
    tier: 'review',
    selectedByDefault: false,
    reasons: [],
    blockers: [],
    lastActivityAt: 0,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 0 },
    fingerprint: 'fp',
    ...overrides
  }
}

describe('sortWorkspaceCleanupCandidates', () => {
  it('orders candidates by name without throwing', () => {
    const candidates = [
      candidate({ worktreeId: 'b', displayName: 'Beta' }),
      candidate({ worktreeId: 'a', displayName: 'Alpha' })
    ]

    expect(
      sortWorkspaceCleanupCandidates(candidates, 'name', 'asc').map((item) => item.worktreeId)
    ).toEqual(['a', 'b'])
  })

  it('sorts candidates with an undefined displayName without throwing (crash 99657ab1)', () => {
    // displayName is typed string but arrives undefined for persisted/discovered candidates.
    const candidates = [
      candidate({ worktreeId: 'named', displayName: 'Beta' }),
      candidate({ worktreeId: 'unnamed', displayName: undefined as unknown as string })
    ]

    for (const sortKey of ['name', 'repo', 'activity'] as const) {
      expect(() => sortWorkspaceCleanupCandidates(candidates, sortKey, 'asc')).not.toThrow()
    }
    // Undefined coalesces to '' which sorts before a real name.
    expect(
      sortWorkspaceCleanupCandidates(candidates, 'name', 'asc').map((item) => item.worktreeId)
    ).toEqual(['unnamed', 'named'])
  })

  it('keeps the name tie-breaker safe when equal-activity rows have undefined names', () => {
    // 'activity' ties fall through to the displayName tie-breaker.
    const candidates = [
      candidate({
        worktreeId: 'a',
        displayName: undefined as unknown as string,
        lastActivityAt: 5
      }),
      candidate({ worktreeId: 'b', displayName: undefined as unknown as string, lastActivityAt: 5 })
    ]

    expect(() => sortWorkspaceCleanupCandidates(candidates, 'activity', 'asc')).not.toThrow()
  })
})
