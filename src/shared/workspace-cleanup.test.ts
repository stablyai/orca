import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  applyWorkspaceCleanupPolicy,
  canQueueWorkspaceCleanupCandidate,
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
  })

  it('keeps legacy verdict fields stable for older clients', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate({ reasons: [] }))

    expect(candidate.tier).toBe('review')
    expect(candidate.selectedByDefault).toBe(false)
  })

  it('queues risk-labelled and recently active candidates', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['unpushed-commits'] }))
    const recent = applyWorkspaceCleanupPolicy(makeCandidate({ reasons: [] }))

    expect(candidate.tier).toBe('protected')
    expect(candidate.selectedByDefault).toBe(false)
    expect(canQueueWorkspaceCleanupCandidate(candidate)).toBe(true)
    expect(canQueueWorkspaceCleanupCandidate(recent)).toBe(true)
    expect(shouldForceWorkspaceCleanupRemoval(candidate)).toBe(true)
  })

  it('keeps active and live-agent rows manually queueable', () => {
    expect(
      canQueueWorkspaceCleanupCandidate(makeCandidate({ blockers: ['active-workspace'] }))
    ).toBe(true)
    expect(canQueueWorkspaceCleanupCandidate(makeCandidate({ blockers: ['live-agent'] }))).toBe(
      true
    )
  })

  it('refuses only operations that cannot be routed', () => {
    const mainWorktree = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['main-worktree'] }))
    const folderProject = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['folder-repo'] }))
    const disconnected = applyWorkspaceCleanupPolicy(
      makeCandidate({ blockers: ['ssh-disconnected'] })
    )
    const dismissed = applyWorkspaceCleanupPolicy(makeCandidate({ blockers: ['dismissed'] }))

    expect(canQueueWorkspaceCleanupCandidate(mainWorktree)).toBe(false)
    expect(canQueueWorkspaceCleanupCandidate(folderProject)).toBe(false)
    expect(canQueueWorkspaceCleanupCandidate(disconnected)).toBe(false)
    expect(canQueueWorkspaceCleanupCandidate(dismissed)).toBe(true)
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
