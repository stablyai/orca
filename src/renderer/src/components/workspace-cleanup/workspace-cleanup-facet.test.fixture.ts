import type { LiveAgentWorktreeStatus } from '@/lib/worktree-activity-state'
import type { WorkspaceCleanupCandidate } from '../../../../shared/workspace-cleanup'
import { cloneDefaultWorkspaceStatuses } from '../../../../shared/workspace-statuses'
import { getWorkspaceCleanupCandidateIdentity } from '../../../../shared/workspace-cleanup-host-identity'
import {
  buildWorkspaceCleanupFacets,
  type WorkspaceCleanupFacetSources,
  type WorkspaceCleanupFacets,
  type WorkspaceCleanupWorktreeFacts
} from './workspace-cleanup-facets'
import type { WorkspaceCleanupReviewInfo } from './workspace-cleanup-presentation'

export const FACET_NOW = 1_700_000_000_000
export const DAY = 24 * 60 * 60 * 1000

export function makeFacetCandidate(
  overrides: Partial<WorkspaceCleanupCandidate> = {}
): WorkspaceCleanupCandidate {
  return {
    worktreeId: 'repo-1::/repo/alpha',
    repoId: 'repo-1',
    repoName: 'Repo',
    connectionId: null,
    displayName: 'alpha',
    branch: 'refs/heads/alpha',
    path: '/repo/alpha',
    tier: 'ready',
    selectedByDefault: true,
    reasons: ['idle-clean'],
    blockers: [],
    lastActivityAt: FACET_NOW - 40 * DAY,
    localContext: {
      terminalTabCount: 0,
      cleanEditorTabCount: 0,
      browserTabCount: 0,
      diffCommentCount: 0,
      newestDiffCommentAt: null,
      retainedDoneAgentCount: 0
    },
    git: { clean: true, upstreamAhead: 0, upstreamBehind: 0, checkedAt: FACET_NOW },
    fingerprint: 'fingerprint',
    ...overrides
  }
}

export function makeWorktreeFacts(
  overrides: Partial<WorkspaceCleanupWorktreeFacts> = {}
): WorkspaceCleanupWorktreeFacts {
  return {
    id: 'repo-1::/repo/alpha',
    branch: 'refs/heads/alpha',
    comment: '',
    isArchived: false,
    isPinned: false,
    isUnread: false,
    linkedIssue: null,
    linkedLinearIssue: null,
    ...overrides
  }
}

export function makeReviewInfo(
  overrides: Partial<WorkspaceCleanupReviewInfo> = {}
): WorkspaceCleanupReviewInfo {
  return {
    hasReview: true,
    label: 'PR #42',
    state: 'open',
    provider: 'github',
    title: 'Alpha cleanup',
    ...overrides
  }
}

export type FacetFixtureInput = {
  candidate?: Partial<WorkspaceCleanupCandidate>
  worktree?: Partial<WorkspaceCleanupWorktreeFacts> | null
  sizeBytes?: number
  lastVisitedAt?: number
  agentStatus?: LiveAgentWorktreeStatus
  review?: Partial<WorkspaceCleanupReviewInfo>
  dismissed?: boolean
}

/** Builds through the real facet builder so tests exercise the production join. */
export function makeFacets(input: FacetFixtureInput = {}): WorkspaceCleanupFacets {
  const candidate = makeFacetCandidate(input.candidate)
  const id = candidate.worktreeId
  const sources: WorkspaceCleanupFacetSources = {
    workspaceStatuses: cloneDefaultWorkspaceStatuses(),
    worktreeById:
      input.worktree === null
        ? new Map()
        : new Map([[id, makeWorktreeFacts({ id, ...input.worktree })]]),
    sizeBytesByWorktreeId:
      input.sizeBytes === undefined ? new Map() : new Map([[id, input.sizeBytes]]),
    lastVisitedAtByWorktreeId:
      input.lastVisitedAt === undefined ? {} : { [id]: input.lastVisitedAt },
    liveAgentStatusByWorktreeId:
      input.agentStatus === undefined ? new Map() : new Map([[id, input.agentStatus]]),
    reviewInfoByWorktreeId:
      input.review === undefined ? new Map() : new Map([[id, makeReviewInfo(input.review)]]),
    // Keyed the way the store writes dismissals: host-qualified identity, not a
    // bare id — a bare-id fixture here would pass while production never matched.
    dismissedIdentities: new Set(
      input.dismissed ? [getWorkspaceCleanupCandidateIdentity(candidate)] : []
    )
  }
  return buildWorkspaceCleanupFacets(candidate, sources)
}

/** Distinct worktree/display identity so tie-break ordering is observable. */
export function makeNamedFacets(
  name: string,
  input: FacetFixtureInput = {}
): WorkspaceCleanupFacets {
  return makeFacets({
    ...input,
    candidate: {
      worktreeId: `repo-1::/repo/${name}`,
      displayName: name,
      path: `/repo/${name}`,
      branch: `refs/heads/${name}`,
      ...input.candidate
    },
    worktree:
      input.worktree === null
        ? null
        : { id: `repo-1::/repo/${name}`, branch: `refs/heads/${name}`, ...input.worktree }
  })
}
