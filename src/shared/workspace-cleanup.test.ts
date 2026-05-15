import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  applyWorkspaceCleanupPolicy,
  canQueueWorkspaceCleanupCandidate,
  canSelectWorkspaceCleanupCandidate,
  createWorkspaceCleanupFingerprint,
  shouldForceWorkspaceCleanupRemoval,
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
    reasons: ['idle-clean'],
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
      checkedAt: 1_700_000_000_000
    },
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
  it('marks clean inactive workspaces as ready and selected', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate())

    expect(candidate.tier).toBe('ready')
    expect(candidate.selectedByDefault).toBe(true)
    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(true)
  })

  it('requires an inactivity reason before selecting a workspace', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate({ reasons: [] }))

    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(false)
    expect(candidate.tier).toBe('review')
    expect(candidate.selectedByDefault).toBe(false)
  })

  it('keeps not-suggested candidates queueable when git evidence is clean', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['unpushed-commits'] }))

    expect(candidate.tier).toBe('protected')
    expect(candidate.selectedByDefault).toBe(false)
    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(false)
    expect(canQueueWorkspaceCleanupCandidate(candidate)).toBe(true)
    expect(shouldForceWorkspaceCleanupRemoval(candidate)).toBe(true)
  })

  it('does not queue main worktrees or folder projects for cleanup removal', () => {
    const mainWorktree = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['main-worktree'] }))
    const folderProject = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['folder-repo'] }))

    expect(canQueueWorkspaceCleanupCandidate(mainWorktree)).toBe(false)
    expect(canQueueWorkspaceCleanupCandidate(folderProject)).toBe(false)
  })

  it('requires current git status before selecting a workspace', () => {
    const candidate = applyWorkspaceCleanupPolicy(
      makeCandidate({
        git: { clean: null, checkedAt: null }
      })
    )

    expect(candidate.tier).toBe('review')
    expect(canSelectWorkspaceCleanupCandidate(candidate)).toBe(false)
  })

  it('matches dismissals only for the current classifier fingerprint', () => {
    const fingerprint = createWorkspaceCleanupFingerprint({
      branch: 'feature',
      head: 'abc123',
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
