import { describe, expect, it } from 'vitest'
import {
  applyWorkspaceCleanupPolicy,
  isKnownWorkspaceCleanupReason,
  isWorkspaceCleanupSelectableReason,
  type WorkspaceCleanupBlocker,
  type WorkspaceCleanupCandidate
} from './workspace-cleanup'

function makeCandidate(
  overrides: Partial<Omit<WorkspaceCleanupCandidate, 'git'>> & {
    git?: Partial<WorkspaceCleanupCandidate['git']>
  } = {}
): WorkspaceCleanupCandidate {
  const { git, ...rest } = overrides
  return {
    worktreeId: 'repo-1::/tmp/feature',
    repoId: 'repo-1',
    repoName: 'Repo',
    connectionId: null,
    displayName: 'feature',
    branch: 'feature',
    path: '/tmp/feature',
    tier: 'review',
    selectedByDefault: false,
    reasons: ['merged'],
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
    fingerprint: 'fingerprint',
    ...rest,
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: 1, ...git }
  }
}

// Every blocker the legacy tiers treat as hard; none may be weakened by a new reason.
const HARD_BLOCKERS: WorkspaceCleanupBlocker[] = [
  'main-worktree',
  'folder-repo',
  'pinned',
  'active-workspace',
  'running-terminal',
  'terminal-liveness-unknown',
  'dirty-editor-buffer',
  'volatile-local-context',
  'recent-visible-context',
  'live-agent',
  'ssh-disconnected',
  'git-status-error',
  'dirty-files',
  'unpushed-commits',
  'unknown-base',
  'dismissed'
]

describe('workspace cleanup signal tiers', () => {
  it.each(['merged', 'stale-agent', 'prunable'] as const)(
    'makes a clean, unblocked %s worktree ready',
    (reason) => {
      expect(applyWorkspaceCleanupPolicy(makeCandidate({ reasons: [reason] }))).toMatchObject({
        tier: 'ready',
        selectedByDefault: true
      })
    }
  )

  it.each(HARD_BLOCKERS)('keeps a merged stale-agent worktree protected by %s', (blocker) => {
    const candidate = applyWorkspaceCleanupPolicy(
      makeCandidate({ reasons: ['merged', 'stale-agent', 'prunable'], blockers: [blocker] })
    )
    expect(candidate).toMatchObject({ tier: 'protected', selectedByDefault: false })
  })

  it('never selects a merged worktree whose git state is unknown', () => {
    const candidate = applyWorkspaceCleanupPolicy(
      makeCandidate({ git: { clean: null, checkedAt: null } })
    )
    expect(candidate).toMatchObject({ tier: 'review', selectedByDefault: false })
  })

  it('keeps an unregistered folder review-only even with clean evidence', () => {
    const candidate = applyWorkspaceCleanupPolicy(makeCandidate({ reasons: ['unregistered'] }))
    expect(candidate).toMatchObject({ tier: 'review', selectedByDefault: false })
    expect(isWorkspaceCleanupSelectableReason('unregistered')).toBe(false)
  })
})

describe('workspace cleanup reasons from a newer host', () => {
  // Why JSON: this is how an unknown reason reaches this build, over IPC or a persisted snapshot.
  const fromNewerHost = (reasons: string[]): WorkspaceCleanupCandidate => ({
    ...makeCandidate(),
    ...JSON.parse(JSON.stringify({ reasons }))
  })

  it('does not let an unknown reason make a row ready on its own', () => {
    const candidate = applyWorkspaceCleanupPolicy(fromNewerHost(['future-signal']))
    expect(isKnownWorkspaceCleanupReason('future-signal')).toBe(false)
    expect(candidate).toMatchObject({ tier: 'review', selectedByDefault: false })
  })

  it('still honors the known reasons next to it', () => {
    const candidate = applyWorkspaceCleanupPolicy(fromNewerHost(['future-signal', 'idle-clean']))
    expect(candidate).toMatchObject({ tier: 'ready', selectedByDefault: true })
    expect(candidate.reasons).toEqual(['future-signal', 'idle-clean'])
  })
})
