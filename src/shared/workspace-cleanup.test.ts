import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  applyWorkspaceCleanupPolicy,
  canSelectWorkspaceCleanupCandidate,
  createWorkspaceCleanupFingerprint,
  shouldHideWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate
} from './workspace-cleanup'

type CandidateOverrides = Partial<Omit<WorkspaceCleanupCandidate, 'git' | 'localContext'>> & {
  git?: Partial<WorkspaceCleanupCandidate['git']>
  localContext?: Partial<WorkspaceCleanupCandidate['localContext']>
}

function makeCandidate(overrides: CandidateOverrides = {}): WorkspaceCleanupCandidate {
  const { git, localContext, ...candidateOverrides } = overrides
  const candidate: WorkspaceCleanupCandidate = {
    worktreeId: 'repo-1::/tmp/feature',
    repoId: 'repo-1',
    repoName: 'Repo',
    connectionId: null,
    displayName: 'feature',
    branch: 'feature',
    path: '/tmp/feature',
    tier: 'review',
    selectedByDefault: false,
    reasons: ['pr-merged'],
    blockers: [],
    lastActivityAt: 1_700_000_000_000,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: {
      clean: true,
      upstreamAhead: 0,
      upstreamBehind: 0,
      branchCompareChangedFiles: null,
      checkedAt: 1_700_000_000_000
    },
    prStateCheckedAt: 1_700_000_000_000,
    staleEvidence: false,
    fingerprint: 'fingerprint',
    ...candidateOverrides
  }
  return {
    ...candidate,
    git: { ...candidate.git, ...git },
    localContext: { ...candidate.localContext, ...localContext }
  }
}

describe('workspace cleanup policy', () => {
  it('marks clean merged workspaces with base proof as ready and selected', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate())

    expect(candidate.tier).toBe('ready')
    expect(candidate.selectedByDefault).toBe(true)
    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(true)
  })

  it('requires a cleanup reason before defaulting a selectable workspace to ready', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate({ reasons: [] }))

    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(true)
    expect(candidate.tier).toBe('review')
    expect(candidate.selectedByDefault).toBe(false)
  })

  it('protects candidates with hard blockers even when git evidence is clean', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['unpushed-commits'] }))

    expect(candidate.tier).toBe('protected')
    expect(candidate.selectedByDefault).toBe(false)
    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(false)
  })

  it('treats missing base proof as not selectable', () => {
    const candidate = applyWorkspaceCleanupPolicy(
      makeCandidate({
        blockers: ['unknown-base'],
        git: { upstreamAhead: null, branchCompareChangedFiles: null }
      })
    )

    expect(candidate.tier).toBe('protected')
    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(false)
  })

  it('matches dismissals only for the current classifier fingerprint', () => {
    const fingerprint = createWorkspaceCleanupFingerprint({
      branch: 'feature',
      head: 'abc123',
      prState: 'merged',
      gitClean: true,
      lastActivityAt: 1_700_000_000_000
    })
    const candidate = makeCandidate({ fingerprint })

    expect(
      shouldHideWorkspaceCleanupCandidate(candidate, {
        worktreeId: candidate.worktreeId,
        dismissedAt: 1_700_000_000_000,
        fingerprint,
        classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
      })
    ).toBe(true)
    expect(
      shouldHideWorkspaceCleanupCandidate(candidate, {
        worktreeId: candidate.worktreeId,
        dismissedAt: 1_700_000_000_000,
        fingerprint: `${fingerprint}|changed`,
        classifierVersion: WORKSPACE_CLEANUP_CLASSIFIER_VERSION
      })
    ).toBe(false)
  })
})
