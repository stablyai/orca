import type { ExecutionHostId } from './execution-host'
import type { HostedReviewProvider } from './hosted-review'
import type { WorkspaceCleanupBlocker, WorkspaceCleanupTier } from './workspace-cleanup'

/** `any` leaves the facet unconstrained; `only`/`exclude` narrow to rows with/without the trait. */
export type WorkspaceCleanupTriState = 'any' | 'only' | 'exclude'

/** `some`/`none` require presence/absence; `any` is unconstrained. */
export type WorkspaceCleanupPresence = 'any' | 'some' | 'none'

/**
 * Which timestamp the idle threshold reads. `last-visited` is the honest
 * "the user actually opened this" signal; `last-activity` is a background
 * signal that ambient PTY/agent churn can bump without any human involvement.
 */
export type WorkspaceCleanupIdleSignal = 'last-visited' | 'last-activity' | 'created'

export type WorkspaceCleanupGitState = 'clean' | 'dirty' | 'unpushed' | 'unknown'
export type WorkspaceCleanupAgentState = 'working' | 'permission' | 'idle'
/** `draft` is a review STATE, not a separate flag. */
export type WorkspaceCleanupReviewState = 'open' | 'draft' | 'merged' | 'closed' | 'unknown'
export type WorkspaceCleanupTicketSource = 'work-item' | 'linear' | 'issue'
export type WorkspaceCleanupBlockerMode = 'any-of' | 'none-of'

export type WorkspaceCleanupSortField =
  | 'last-activity'
  | 'last-visited'
  | 'created'
  | 'size'
  | 'name'
  | 'repo'
  | 'path'
  | 'host'
  | 'workspace-status'
  | 'agent'
  | 'git'
  | 'ahead'
  | 'behind'
  | 'branch'
  | 'review'
  | 'ticket'
  | 'local-context'
  | 'tier'
  | 'blocker-count'

export type WorkspaceCleanupSortDirectionState = 'asc' | 'desc'

export type WorkspaceCleanupSortState = {
  field: WorkspaceCleanupSortField
  direction: WorkspaceCleanupSortDirectionState
}

export type WorkspaceCleanupActivityFilter = {
  idleSignal: WorkspaceCleanupIdleSignal
  /** "no signal in the last N days"; null disables the threshold. User-chosen, not a fixed enum. */
  idleMinDays: number | null
  /** Rows Orca never recorded a user-initiated visit for. */
  neverVisited: boolean
}

export type WorkspaceCleanupSizeFilter = {
  minBytes: number | null
  maxBytes: number | null
  /** The space scan is opt-in, so unsized rows stay visible unless the user opts out. */
  includeUnsized: boolean
}

export type WorkspaceCleanupStatusFilter = {
  /** Open string ids from `settings.workspaceStatuses`; empty leaves status unconstrained. */
  workspaceStatuses: string[]
  /** Also pass rows with no status while `workspaceStatuses` is non-empty. */
  matchStatusless: boolean
  archived: WorkspaceCleanupTriState
  pinned: WorkspaceCleanupTriState
  unread: WorkspaceCleanupTriState
  comment: WorkspaceCleanupTriState
}

export type WorkspaceCleanupAgentFilter = {
  states: WorkspaceCleanupAgentState[]
  retainedDoneAgents: WorkspaceCleanupTriState
}

export type WorkspaceCleanupGitFilterState = {
  states: WorkspaceCleanupGitState[]
  minAhead: number | null
  minBehind: number | null
  branchQuery: string
  prunable: WorkspaceCleanupTriState
  locked: WorkspaceCleanupTriState
}

export type WorkspaceCleanupReviewFilterState = {
  presence: WorkspaceCleanupPresence
  states: WorkspaceCleanupReviewState[]
  /** Provider-general: github/gitlab/bitbucket/azure-devops/gitea all land here. */
  providers: HostedReviewProvider[]
}

export type WorkspaceCleanupTicketFilter = {
  presence: WorkspaceCleanupPresence
  sources: WorkspaceCleanupTicketSource[]
}

export type WorkspaceCleanupContextFilterState = {
  presence: WorkspaceCleanupPresence
  /** No local context, no review, no ticket, no comment — nothing left to lose. */
  completelyEmpty: boolean
}

export type WorkspaceCleanupLocationFilter = {
  hostIds: ExecutionHostId[]
  repoIds: string[]
  pathPrefix: string
}

export type WorkspaceCleanupSafetyFilter = {
  blockers: WorkspaceCleanupBlocker[]
  blockerMode: WorkspaceCleanupBlockerMode
  tiers: WorkspaceCleanupTier[]
  dismissed: WorkspaceCleanupTriState
  /** Only rows the cleanup policy would actually let the user delete. */
  selectableOnly: boolean
}

export type WorkspaceCleanupFilterState = {
  query: string
  activity: WorkspaceCleanupActivityFilter
  size: WorkspaceCleanupSizeFilter
  status: WorkspaceCleanupStatusFilter
  agent: WorkspaceCleanupAgentFilter
  git: WorkspaceCleanupGitFilterState
  review: WorkspaceCleanupReviewFilterState
  ticket: WorkspaceCleanupTicketFilter
  context: WorkspaceCleanupContextFilterState
  location: WorkspaceCleanupLocationFilter
  safety: WorkspaceCleanupSafetyFilter
}

/** Fresh object every call — filter state is mutated by the UI and stored per dialog. */
export function createDefaultWorkspaceCleanupFilterState(): WorkspaceCleanupFilterState {
  return {
    query: '',
    activity: { idleSignal: 'last-visited', idleMinDays: null, neverVisited: false },
    size: { minBytes: null, maxBytes: null, includeUnsized: true },
    status: {
      workspaceStatuses: [],
      matchStatusless: true,
      archived: 'any',
      pinned: 'any',
      unread: 'any',
      comment: 'any'
    },
    agent: { states: [], retainedDoneAgents: 'any' },
    git: {
      states: [],
      minAhead: null,
      minBehind: null,
      branchQuery: '',
      prunable: 'any',
      locked: 'any'
    },
    review: { presence: 'any', states: [], providers: [] },
    ticket: { presence: 'any', sources: [] },
    context: { presence: 'any', completelyEmpty: false },
    location: { hostIds: [], repoIds: [], pathPrefix: '' },
    safety: {
      blockers: [],
      blockerMode: 'none-of',
      tiers: [],
      dismissed: 'any',
      selectableOnly: false
    }
  }
}

export const DEFAULT_WORKSPACE_CLEANUP_SORT: WorkspaceCleanupSortState = {
  field: 'last-activity',
  direction: 'asc'
}
