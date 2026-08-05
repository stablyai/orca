import { describe, expect, it } from 'vitest'
import {
  WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS,
  WORKSPACE_CLEANUP_CLASSIFIER_VERSION,
  WORKSPACE_CLEANUP_IDLE_MS,
  applyWorkspaceCleanupPolicy,
  canQueueWorkspaceCleanupCandidate,
  canSelectWorkspaceCleanupCandidate,
  createWorkspaceCleanupFingerprint,
  getWorkspaceCleanupInactivityReasons,
  shouldForceWorkspaceCleanupRemoval,
  shouldHideWorkspaceCleanupCandidate,
  type WorkspaceCleanupCandidate,
  type WorkspaceCleanupInactivityInput
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
    repoPath: '/tmp/repo-1',
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

describe('workspace cleanup inactivity reasons (T12 worktree-ghost)', () => {
  const NOW = 1_700_000_000_000

  it('adds worktree-ghost for prunable worktrees regardless of age (zero age gate)', () => {
    const ghostOld = {
      isArchived: false,
      lastActivityAt: NOW - 17 * 24 * 60 * 60 * 1000,
      isPrunable: true
    }
    const ghostYoung = {
      isArchived: false,
      lastActivityAt: NOW - 1 * 24 * 60 * 60 * 1000,
      isPrunable: true
    }

    expect(getWorkspaceCleanupInactivityReasons(ghostOld, NOW)).toEqual(['worktree-ghost'])
    expect(getWorkspaceCleanupInactivityReasons(ghostYoung, NOW)).toEqual(['worktree-ghost'])
  })

  it('keeps the 30-day idle gate for non-prunable worktrees (humans unchanged)', () => {
    const humanRecent = {
      isArchived: false,
      lastActivityAt: NOW - 17 * 24 * 60 * 60 * 1000,
      isPrunable: false
    }
    const humanOld = {
      isArchived: false,
      lastActivityAt: NOW - WORKSPACE_CLEANUP_IDLE_MS,
      isPrunable: false
    }

    expect(getWorkspaceCleanupInactivityReasons(humanRecent, NOW)).toEqual([])
    expect(getWorkspaceCleanupInactivityReasons(humanOld, NOW)).toEqual(['idle-clean'])
  })

  it('keeps the 7-day archived gate for non-prunable archived worktrees', () => {
    const archived = {
      isArchived: true,
      lastActivityAt: NOW - WORKSPACE_CLEANUP_ARCHIVED_IDLE_MS,
      isPrunable: false
    }
    expect(getWorkspaceCleanupInactivityReasons(archived, NOW)).toEqual(['archived'])
  })

  it('handles null/partial input defensively', () => {
    // Runtime defense: the typed contract is non-nullable, but JS callers may
    // pass garbage — assert the classifier never crashes on it.
    expect(
      getWorkspaceCleanupInactivityReasons(
        null as unknown as WorkspaceCleanupInactivityInput,
        NOW
      )
    ).toEqual([])
    expect(
      getWorkspaceCleanupInactivityReasons(
        undefined as unknown as WorkspaceCleanupInactivityInput,
        NOW
      )
    ).toEqual([])
  })
})
