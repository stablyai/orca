import {
  createDefaultWorkspaceCleanupFilterState,
  type WorkspaceCleanupFilterState
} from './workspace-cleanup-filter-model'

/**
 * One constraint the user can see and remove from the filter bar.
 *
 * Deliberately per-field, not per-group: "Activity" tells a reader nothing, while
 * "Idle >= 20d" names the thing that is hiding their workspaces. That naming *is* the
 * fix — the reported defect was never that the effect was invisible (the bar always
 * read "Showing 546 of 799"), it was that the cause was.
 */
export type WorkspaceCleanupAppliedFilter = {
  /** Stable across renders and unique per constraint. */
  id: string
  /** Rendered on the chip. Already localized by the caller-supplied formatter. */
  label: string
  /** Returns `filters` with just this constraint reset to its default. */
  clear: (filters: WorkspaceCleanupFilterState) => WorkspaceCleanupFilterState
}

type Formatters = {
  idleDays: (days: number) => string
  neverVisited: () => string
  minSize: (bytes: number) => string
  maxSize: (bytes: number) => string
  excludesUnsized: () => string
  excludesStatusless: () => string
  list: (kind: string, count: number) => string
  triState: (kind: string, mode: 'only' | 'exclude') => string
  minAhead: (count: number) => string
  minBehind: (count: number) => string
  branchQuery: (value: string) => string
  pathPrefix: (value: string) => string
  presence: (kind: string, mode: string) => string
  completelyEmpty: () => string
}

/**
 * Every constraint currently narrowing the fleet, in panel order.
 *
 * A field counts only when its matcher actually narrows. That is why minimums count
 * above zero but `size.maxBytes` counts *at* zero: a `0` minimum matches every row,
 * while "at most 0 MB" hides every measured non-empty workspace.
 */
export function listAppliedWorkspaceCleanupFilters(
  filters: WorkspaceCleanupFilterState,
  format: Formatters
): WorkspaceCleanupAppliedFilter[] {
  const defaults = createDefaultWorkspaceCleanupFilterState()
  const applied: WorkspaceCleanupAppliedFilter[] = []
  const add = (
    id: string,
    label: string,
    clear: (f: WorkspaceCleanupFilterState) => WorkspaceCleanupFilterState
  ): void => {
    applied.push({ id, label, clear })
  }

  const { activity, size, status, agent, git, review, ticket, context, location, safety } = filters

  if (activity.idleMinDays !== null && activity.idleMinDays > 0) {
    add('activity.idleMinDays', format.idleDays(activity.idleMinDays), (f) => ({
      ...f,
      activity: { ...f.activity, idleMinDays: null }
    }))
  }
  if (activity.neverVisited) {
    add('activity.neverVisited', format.neverVisited(), (f) => ({
      ...f,
      activity: { ...f.activity, neverVisited: false }
    }))
  }

  if (size.minBytes !== null && size.minBytes > 0) {
    add('size.minBytes', format.minSize(size.minBytes), (f) => ({
      ...f,
      size: { ...f.size, minBytes: null }
    }))
  }
  if (size.maxBytes !== null) {
    add('size.maxBytes', format.maxSize(size.maxBytes), (f) => ({
      ...f,
      size: { ...f.size, maxBytes: null }
    }))
  }
  if (!size.includeUnsized) {
    add('size.includeUnsized', format.excludesUnsized(), (f) => ({
      ...f,
      size: { ...f.size, includeUnsized: true }
    }))
  }

  if (status.workspaceStatuses.length > 0) {
    add('status.workspaceStatuses', format.list('status', status.workspaceStatuses.length), (f) => ({
      ...f,
      status: { ...f.status, workspaceStatuses: [] }
    }))
  }
  if (!status.matchStatusless) {
    add('status.matchStatusless', format.excludesStatusless(), (f) => ({
      ...f,
      status: { ...f.status, matchStatusless: true }
    }))
  }
  for (const key of ['archived', 'pinned', 'unread', 'comment'] as const) {
    const value = status[key]
    if (value !== 'any') {
      add(`status.${key}`, format.triState(key, value), (f) => ({
        ...f,
        status: { ...f.status, [key]: 'any' }
      }))
    }
  }

  if (agent.states.length > 0) {
    add('agent.states', format.list('agent', agent.states.length), (f) => ({
      ...f,
      agent: { ...f.agent, states: [] }
    }))
  }
  if (agent.retainedDoneAgents !== 'any') {
    add('agent.retainedDoneAgents', format.triState('retainedAgents', agent.retainedDoneAgents), (f) => ({
      ...f,
      agent: { ...f.agent, retainedDoneAgents: 'any' }
    }))
  }

  if (git.states.length > 0) {
    add('git.states', format.list('git', git.states.length), (f) => ({
      ...f,
      git: { ...f.git, states: [] }
    }))
  }
  if (git.minAhead !== null && git.minAhead > 0) {
    add('git.minAhead', format.minAhead(git.minAhead), (f) => ({
      ...f,
      git: { ...f.git, minAhead: null }
    }))
  }
  if (git.minBehind !== null && git.minBehind > 0) {
    add('git.minBehind', format.minBehind(git.minBehind), (f) => ({
      ...f,
      git: { ...f.git, minBehind: null }
    }))
  }
  if (git.branchQuery.trim().length > 0) {
    add('git.branchQuery', format.branchQuery(git.branchQuery.trim()), (f) => ({
      ...f,
      git: { ...f.git, branchQuery: '' }
    }))
  }
  for (const key of ['prunable', 'locked'] as const) {
    const value = git[key]
    if (value !== 'any') {
      add(`git.${key}`, format.triState(key, value), (f) => ({
        ...f,
        git: { ...f.git, [key]: 'any' }
      }))
    }
  }

  if (review.presence !== 'any') {
    add('review.presence', format.presence('review', review.presence), (f) => ({
      ...f,
      review: { ...f.review, presence: defaults.review.presence }
    }))
  }
  if (review.states.length > 0) {
    add('review.states', format.list('reviewState', review.states.length), (f) => ({
      ...f,
      review: { ...f.review, states: [] }
    }))
  }
  if (review.providers.length > 0) {
    add('review.providers', format.list('reviewProvider', review.providers.length), (f) => ({
      ...f,
      review: { ...f.review, providers: [] }
    }))
  }

  if (ticket.presence !== 'any') {
    add('ticket.presence', format.presence('ticket', ticket.presence), (f) => ({
      ...f,
      ticket: { ...f.ticket, presence: defaults.ticket.presence }
    }))
  }
  if (ticket.sources.length > 0) {
    add('ticket.sources', format.list('ticketSource', ticket.sources.length), (f) => ({
      ...f,
      ticket: { ...f.ticket, sources: [] }
    }))
  }

  if (context.presence !== 'any') {
    add('context.presence', format.presence('context', context.presence), (f) => ({
      ...f,
      context: { ...f.context, presence: defaults.context.presence }
    }))
  }
  if (context.completelyEmpty) {
    add('context.completelyEmpty', format.completelyEmpty(), (f) => ({
      ...f,
      context: { ...f.context, completelyEmpty: false }
    }))
  }

  if (location.hostIds.length > 0) {
    add('location.hostIds', format.list('host', location.hostIds.length), (f) => ({
      ...f,
      location: { ...f.location, hostIds: [] }
    }))
  }
  if (location.repoIds.length > 0) {
    add('location.repoIds', format.list('repo', location.repoIds.length), (f) => ({
      ...f,
      location: { ...f.location, repoIds: [] }
    }))
  }
  if (location.pathPrefix.trim().length > 0) {
    add('location.pathPrefix', format.pathPrefix(location.pathPrefix.trim()), (f) => ({
      ...f,
      location: { ...f.location, pathPrefix: '' }
    }))
  }

  if (safety.blockers.length > 0) {
    add('safety.blockers', format.list('blocker', safety.blockers.length), (f) => ({
      ...f,
      safety: { ...f.safety, blockers: [] }
    }))
  }
  if (safety.dismissed !== 'any') {
    add('safety.dismissed', format.triState('dismissed', safety.dismissed), (f) => ({
      ...f,
      safety: { ...f.safety, dismissed: 'any' }
    }))
  }

  return applied
}
