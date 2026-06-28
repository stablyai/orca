import type { AppState } from '@/store/types'
import type { HostedReviewInfo } from '../../../../shared/hosted-review'
import type { Repo, Worktree } from '../../../../shared/types'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { translate } from '@/i18n/i18n'
import type { WorkspaceCleanupFilters } from './workspace-cleanup-presentation'

export const NOW = 1_700_000_000_000

const REPO: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Repo',
  badgeColor: '#000',
  addedAt: NOW
}

export const DEFAULT_FILTERS: WorkspaceCleanupFilters = {
  query: '',
  time: 'all',
  review: 'all',
  git: 'all',
  context: 'all'
}

export function makeCandidate(
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return {
    worktreeId: 'repo-1::/repo/alpha',
    repoId: 'repo-1',
    repoName: 'Repo',
    connectionId: null,
    displayName: 'alpha',
    branch: 'alpha',
    path: '/repo/alpha',
    tier: 'ready',
    selectedByDefault: true,
    reasons: ['idle-clean'],
    blockers: [],
    lastActivityAt: NOW - 40 * 24 * 60 * 60 * 1000,
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
      checkedAt: NOW
    },
    fingerprint: 'fingerprint',
    ...overrides
  }
}

export function makeWorktree(overrides: Partial<Worktree> = {}): Worktree {
  return {
    id: 'repo-1::/repo/alpha',
    repoId: 'repo-1',
    displayName: 'alpha',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: NOW,
    path: '/repo/alpha',
    head: 'abc',
    branch: 'refs/heads/alpha',
    isBare: false,
    isMainWorktree: false,
    ...overrides
  }
}

export function makeReview(overrides: Partial<HostedReviewInfo> = {}): HostedReviewInfo {
  return {
    provider: 'github',
    number: 42,
    title: translate(
      'auto.components.workspace.cleanup.presentationFixtures.5ed71d83ef',
      'Review alpha cleanup'
    ),
    state: 'open',
    url: 'https://example.test/review/42',
    status: 'neutral',
    updatedAt: new Date(NOW).toISOString(),
    mergeable: 'UNKNOWN',
    ...overrides
  }
}

export function makeState(overrides: Partial<AppState> = {}): AppState {
  return {
    worktreesByRepo: {
      'repo-1': [makeWorktree()]
    },
    repos: [REPO],
    hostedReviewCache: {},
    settings: {},
    ...overrides
  } as AppState & Partial<AppState>
}
