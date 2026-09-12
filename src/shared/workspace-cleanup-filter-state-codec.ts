import { normalizeExecutionHostId, type ExecutionHostId } from './execution-host'
import type { HostedReviewProvider } from './hosted-review'
import {
  WORKSPACE_CLEANUP_AGENT_STATE_VALUES,
  WORKSPACE_CLEANUP_BLOCKER_MODE_VALUES,
  WORKSPACE_CLEANUP_BLOCKER_VALUES,
  WORKSPACE_CLEANUP_GIT_STATE_VALUES,
  WORKSPACE_CLEANUP_IDLE_SIGNAL_VALUES,
  WORKSPACE_CLEANUP_PRESENCE_VALUES,
  WORKSPACE_CLEANUP_REVIEW_STATE_VALUES,
  WORKSPACE_CLEANUP_SORT_DIRECTION_VALUES,
  WORKSPACE_CLEANUP_SORT_FIELD_VALUES,
  WORKSPACE_CLEANUP_TICKET_SOURCE_VALUES,
  WORKSPACE_CLEANUP_TRI_STATE_VALUES
} from './workspace-cleanup-facet-rankings'
import {
  createDefaultWorkspaceCleanupFilterState,
  DEFAULT_WORKSPACE_CLEANUP_SORT,
  type WorkspaceCleanupFilterState,
  type WorkspaceCleanupSortState
} from './workspace-cleanup-filter-model'

// Provider-general: every hosted-review provider is selectable, never a GitHub special case.
const REVIEW_PROVIDER_VALUES: HostedReviewProvider[] = [
  'github',
  'gitlab',
  'bitbucket',
  'azure-devops',
  'gitea',
  'unsupported'
]

/**
 * Tolerant by design: this reads user data written by older (and newer) Orca
 * builds, so anything unrecognized falls back to the default rather than
 * throwing away the whole persisted filter state.
 */
export function normalizeWorkspaceCleanupFilterState(value: unknown): WorkspaceCleanupFilterState {
  const base = createDefaultWorkspaceCleanupFilterState()
  const raw = asRecord(value)
  const activity = asRecord(raw.activity)
  const size = asRecord(raw.size)
  const status = asRecord(raw.status)
  const agent = asRecord(raw.agent)
  const git = asRecord(raw.git)
  const review = asRecord(raw.review)
  const ticket = asRecord(raw.ticket)
  const context = asRecord(raw.context)
  const location = asRecord(raw.location)
  const safety = asRecord(raw.safety)
  return {
    query: asString(raw.query, base.query),
    activity: {
      idleSignal: asEnum(
        activity.idleSignal,
        WORKSPACE_CLEANUP_IDLE_SIGNAL_VALUES,
        base.activity.idleSignal
      ),
      idleMinDays: asNullableNumber(activity.idleMinDays, base.activity.idleMinDays, 0),
      neverVisited: asBoolean(activity.neverVisited, base.activity.neverVisited)
    },
    size: {
      minBytes: asNullableNumber(size.minBytes, base.size.minBytes, 0),
      maxBytes: asNullableNumber(size.maxBytes, base.size.maxBytes, 0),
      includeUnsized: asBoolean(size.includeUnsized, base.size.includeUnsized)
    },
    status: {
      workspaceStatuses: asStringList(status.workspaceStatuses),
      matchStatusless: asBoolean(status.matchStatusless, base.status.matchStatusless),
      archived: asTriState(status.archived, base.status.archived),
      pinned: asTriState(status.pinned, base.status.pinned),
      unread: asTriState(status.unread, base.status.unread),
      comment: asTriState(status.comment, base.status.comment)
    },
    agent: {
      states: asEnumList(agent.states, WORKSPACE_CLEANUP_AGENT_STATE_VALUES),
      retainedDoneAgents: asTriState(agent.retainedDoneAgents, base.agent.retainedDoneAgents)
    },
    git: {
      states: asEnumList(git.states, WORKSPACE_CLEANUP_GIT_STATE_VALUES),
      minAhead: asNullableNumber(git.minAhead, base.git.minAhead, 0),
      minBehind: asNullableNumber(git.minBehind, base.git.minBehind, 0),
      branchQuery: asString(git.branchQuery, base.git.branchQuery),
      prunable: asTriState(git.prunable, base.git.prunable),
      locked: asTriState(git.locked, base.git.locked)
    },
    review: {
      presence: asEnum(review.presence, WORKSPACE_CLEANUP_PRESENCE_VALUES, base.review.presence),
      states: asEnumList(review.states, WORKSPACE_CLEANUP_REVIEW_STATE_VALUES),
      providers: asEnumList(review.providers, REVIEW_PROVIDER_VALUES)
    },
    ticket: {
      presence: asEnum(ticket.presence, WORKSPACE_CLEANUP_PRESENCE_VALUES, base.ticket.presence),
      sources: asEnumList(ticket.sources, WORKSPACE_CLEANUP_TICKET_SOURCE_VALUES)
    },
    context: {
      presence: asEnum(context.presence, WORKSPACE_CLEANUP_PRESENCE_VALUES, base.context.presence),
      completelyEmpty: asBoolean(context.completelyEmpty, base.context.completelyEmpty)
    },
    location: {
      hostIds: asExecutionHostIdList(location.hostIds),
      repoIds: asStringList(location.repoIds),
      pathPrefix: asString(location.pathPrefix, base.location.pathPrefix)
    },
    safety: {
      blockers: asEnumList(safety.blockers, WORKSPACE_CLEANUP_BLOCKER_VALUES),
      blockerMode: asEnum(
        safety.blockerMode,
        WORKSPACE_CLEANUP_BLOCKER_MODE_VALUES,
        base.safety.blockerMode
      ),
      dismissed: asTriState(safety.dismissed, base.safety.dismissed)
    }
  }
}

export function normalizeWorkspaceCleanupSortState(value: unknown): WorkspaceCleanupSortState {
  const raw = asRecord(value)
  return {
    field: asEnum(
      raw.field,
      WORKSPACE_CLEANUP_SORT_FIELD_VALUES,
      DEFAULT_WORKSPACE_CLEANUP_SORT.field
    ),
    direction: asEnum(
      raw.direction,
      WORKSPACE_CLEANUP_SORT_DIRECTION_VALUES,
      DEFAULT_WORKSPACE_CLEANUP_SORT.direction
    )
  }
}

export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

export function asNullableNumber(
  value: unknown,
  fallback: number | null,
  min?: number
): number | null {
  if (value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return min !== undefined && value < min ? min : value
}

export function asEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export function asEnumList<T extends string>(value: unknown, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  const result: T[] = []
  for (const entry of value) {
    if (
      typeof entry === 'string' &&
      (allowed as readonly string[]).includes(entry) &&
      !seen.has(entry)
    ) {
      seen.add(entry)
      result.push(entry as T)
    }
  }
  return result
}

export function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return []
  }
  const seen = new Set<string>()
  for (const entry of value) {
    if (typeof entry === 'string' && entry.length > 0) {
      seen.add(entry)
    }
  }
  return [...seen]
}

function asExecutionHostIdList(value: unknown): ExecutionHostId[] {
  if (!Array.isArray(value)) {
    return []
  }
  const result = new Set<ExecutionHostId>()
  for (const entry of value) {
    if (typeof entry !== 'string') {
      continue
    }
    const hostId = normalizeExecutionHostId(entry)
    if (hostId) {
      result.add(hostId)
    }
  }
  return [...result]
}

function asTriState(
  value: unknown,
  fallback: WorkspaceCleanupFilterState['status']['archived']
): WorkspaceCleanupFilterState['status']['archived'] {
  return asEnum(value, WORKSPACE_CLEANUP_TRI_STATE_VALUES, fallback)
}
