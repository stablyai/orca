import { useEffect, useMemo, useRef } from 'react'

import { useAppStore } from '@/store'
import { beadsIssueListCacheKey, type BeadsListErrorKind } from '@/store/slices/beads'
import {
  compareBeadsUpdatedAtDesc,
  type BeadsIssue,
  type BeadsWorkspaceStatus
} from '../../../shared/beads-types'
import {
  BEADS_CORE_ISSUE_TYPES,
  BEADS_QUERY_ISSUE_TYPES,
  matchesBeadsTaskQuery,
  type BeadsIssueFetchPlan,
  type ParsedBeadsTaskQuery
} from '../../../shared/beads-task-query'
import type { ExecutionHostRegistryEntry } from '../../../shared/execution-host-registry'
import { BEADS_TASK_SOURCE_RUNTIME_CAPABILITY } from '../../../shared/protocol-version'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { TaskSourceHostAvailability } from './task-source-context-summary'

/** One beads issue plus the repo-backed context it was read from, so Start links back to the right repo/host. */
export type TaskPageBeadsIssueRow = {
  issue: BeadsIssue
  sourceContext: TaskSourceContext
}

export type TaskPageBeadsRepoResult = {
  context: TaskSourceContext
  issues: BeadsIssue[]
  status: BeadsWorkspaceStatus | null
  error: BeadsListErrorKind | null
  /** False until the first fetch for this repo/preset settles (cache entry exists). */
  checked: boolean
}

export type TaskPageBeadsIssuesState = {
  rows: TaskPageBeadsIssueRow[]
  results: TaskPageBeadsRepoResult[]
  loading: boolean
}

export type TaskPageBeadsListState =
  | 'loading'
  | 'capability-missing'
  | 'bd-missing'
  | 'bd-outdated'
  | 'not-initialized'
  | 'error'
  | 'empty-filtered'
  | 'empty'
  | 'ready'

/** SWR fan-out over the selected repos' beads lists; the slice cache is the source of truth. */
export function useTaskPageBeadsIssues(args: {
  enabled: boolean
  contexts: readonly TaskSourceContext[]
  plan: BeadsIssueFetchPlan
  refreshNonce: number
}): TaskPageBeadsIssuesState {
  const { enabled, contexts, plan, refreshNonce } = args
  const fetchBeadsIssues = useAppStore((s) => s.fetchBeadsIssues)
  const beadsListCache = useAppStore((s) => s.beadsListCache)
  const cacheKeys = useMemo(
    () => contexts.map((context) => beadsIssueListCacheKey(context, plan)),
    [contexts, plan]
  )
  const contextsKey = cacheKeys.join('|')
  const lastRefreshNonceRef = useRef(refreshNonce)

  useEffect(() => {
    if (!enabled) {
      return
    }
    const force = lastRefreshNonceRef.current !== refreshNonce
    lastRefreshNonceRef.current = refreshNonce
    for (const context of contexts) {
      // Why: failures land in the slice cache entry; the list derives its error state from there.
      void fetchBeadsIssues(context, plan, force ? { force: true } : undefined).catch(() => {})
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- contextsKey stands in for the contexts array identity
  }, [enabled, contextsKey, plan, refreshNonce, fetchBeadsIssues])

  const results = useMemo<TaskPageBeadsRepoResult[]>(
    () =>
      contexts.map((context, index) => {
        const entry = beadsListCache[cacheKeys[index]]
        return {
          context,
          issues: entry?.data?.issues ?? [],
          status: entry?.data?.status ?? null,
          error: entry?.error ?? null,
          checked: entry !== undefined
        }
      }),
    [beadsListCache, cacheKeys, contexts]
  )

  const rows = useMemo<TaskPageBeadsIssueRow[]>(() => {
    const merged = results.flatMap((result) =>
      result.issues.map((issue) => ({ issue, sourceContext: result.context }))
    )
    return merged.sort((a, b) => compareBeadsUpdatedAtDesc(a.issue, b.issue))
  }, [results])

  return {
    rows,
    results,
    loading: enabled && results.some((result) => !result.checked)
  }
}

/**
 * Client-side pass over the fetched list; the fetch plan already narrowed the
 * status scope. With no type qualifiers the list defaults to the core work
 * types (also under is:ready); an explicit is:<type> or type facet always wins.
 */
export function filterBeadsIssueRows(
  rows: readonly TaskPageBeadsIssueRow[],
  query: ParsedBeadsTaskQuery
): TaskPageBeadsIssueRow[] {
  return rows.filter(
    ({ issue }) =>
      (query.types.length > 0 || BEADS_CORE_ISSUE_TYPES.includes(issue.issueType)) &&
      matchesBeadsTaskQuery(issue, query)
  )
}

export const BEADS_DEFAULT_ISSUE_TYPES: readonly string[] = BEADS_QUERY_ISSUE_TYPES

export type TaskPageBeadsFacetOptions = {
  labels: string[]
  assignees: string[]
  types: string[]
}

/** Facet option values observed in the fetched list; types always include bd's built-in kinds. */
export function deriveTaskPageBeadsFacetOptions(
  rows: readonly TaskPageBeadsIssueRow[]
): TaskPageBeadsFacetOptions {
  const labels = new Set<string>()
  const assignees = new Set<string>()
  const extraTypes = new Set<string>()
  for (const { issue } of rows) {
    for (const label of issue.labels) {
      labels.add(label)
    }
    if (issue.assignee) {
      assignees.add(issue.assignee)
    }
    if (!BEADS_DEFAULT_ISSUE_TYPES.includes(issue.issueType)) {
      extraTypes.add(issue.issueType)
    }
  }
  return {
    labels: [...labels].sort((a, b) => a.localeCompare(b)),
    assignees: [...assignees].sort((a, b) => a.localeCompare(b)),
    types: [...BEADS_DEFAULT_ISSUE_TYPES, ...[...extraTypes].sort((a, b) => a.localeCompare(b))]
  }
}

function isUsableBeadsStatus(status: BeadsWorkspaceStatus | null): boolean {
  return status !== null && status.bdInstalled && status.versionSupported && status.initialized
}

export function deriveTaskPageBeadsListState(args: {
  results: readonly TaskPageBeadsRepoResult[]
  filteredCount: number
  totalCount: number
  queryActive: boolean
}): TaskPageBeadsListState {
  const { results, filteredCount, totalCount, queryActive } = args
  if (results.length === 0) {
    return 'empty'
  }
  const checked = results.filter((result) => result.checked)
  if (checked.length === 0) {
    return 'loading'
  }
  if (filteredCount > 0) {
    return 'ready'
  }
  if (totalCount > 0 && queryActive) {
    return 'empty-filtered'
  }
  if (checked.some((result) => isUsableBeadsStatus(result.status))) {
    return checked.some((result) => result.error === 'load-failed') ? 'error' : 'empty'
  }
  // Why: nothing readable anywhere — pick the most actionable setup hint.
  if (checked.some((result) => result.error === 'missing-task-source-capability')) {
    return 'capability-missing'
  }
  const statuses = checked.flatMap((result) => (result.status ? [result.status] : []))
  if (statuses.some((status) => !status.bdInstalled)) {
    return 'bd-missing'
  }
  if (statuses.some((status) => status.bdInstalled && !status.versionSupported)) {
    return 'bd-outdated'
  }
  if (statuses.some((status) => !status.initialized)) {
    return 'not-initialized'
  }
  return 'error'
}

/**
 * Host availability for the beads source. Connectivity and the beads runtime capability
 * come from the host registry; `results` adds fetch-derived bd availability
 * ('unavailable-source-tool') and typed capability rejections from older remote hosts.
 */
export function getBeadsTaskSourceHostAvailability(args: {
  contexts: readonly TaskSourceContext[]
  hostRegistryById: ReadonlyMap<TaskSourceContext['hostId'], ExecutionHostRegistryEntry>
  results?: readonly TaskPageBeadsRepoResult[]
}): TaskSourceHostAvailability[] {
  const availability: TaskSourceHostAvailability[] = []
  const seen = new Set<string>()
  const push = (entry: TaskSourceHostAvailability): void => {
    const key = `${entry.hostId}\u0000${entry.reason ?? entry.health ?? entry.status ?? ''}`
    if (!seen.has(key)) {
      seen.add(key)
      availability.push(entry)
    }
  }
  for (const context of args.contexts) {
    const host = args.hostRegistryById.get(context.hostId)
    if (!host) {
      continue
    }
    if (host.kind === 'runtime') {
      if (!host.capabilities) {
        push({ hostId: context.hostId, reason: 'checking-task-source-capability' })
        continue
      }
      if (!host.capabilities.includes(BEADS_TASK_SOURCE_RUNTIME_CAPABILITY)) {
        push({ hostId: context.hostId, reason: 'missing-task-source-capability' })
        continue
      }
    }
    if (host.health !== 'local' && host.health !== 'available') {
      push({ hostId: context.hostId, health: host.health, status: host.connectionStatus })
    }
  }
  for (const result of args.results ?? []) {
    if (result.error === 'missing-task-source-capability') {
      push({ hostId: result.context.hostId, reason: 'missing-task-source-capability' })
    } else if (result.status && !(result.status.bdInstalled && result.status.versionSupported)) {
      push({ hostId: result.context.hostId, reason: 'unavailable-source-tool' })
    } else if (result.status && !result.status.initialized) {
      // Why: in mixed selections a repo without .beads must not just vanish from the merged list.
      push({ hostId: result.context.hostId, reason: 'uninitialized-source-workspace' })
    }
  }
  return availability
}
