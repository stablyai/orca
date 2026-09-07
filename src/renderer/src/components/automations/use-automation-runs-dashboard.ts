import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import { ownerKey } from '../../../../shared/automation-owner-key'
import { capturedAutomationOwner, capturedAutomationOwnerKey } from './automation-captured-owner'
import {
  getAutomationHostTargetKey,
  listAutomationRunsForTarget,
  type AutomationHostTarget
} from './automation-host-client'
import type { AutomationListRow } from './automation-list-row-identity'
import {
  dispatchAutomationRunHistoryPage,
  type AutomationDispatchContext
} from './automation-row-action-dispatch'
import {
  buildAutomationRunsDashboardEntries,
  getAutomationRunsScope,
  type AutomationRunsDashboardFailure
} from './automation-runs-dashboard-model'

const FETCH_CONCURRENCY = 4
// The persistence contract retains at most 100 final runs per automation;
// fetching that bound keeps summary cards complete without an extra scan.
const RUNS_PAGE_SIZE = 100

type DashboardState = {
  entries: ReturnType<typeof buildAutomationRunsDashboardEntries>
  failures: AutomationRunsDashboardFailure[]
  loading: boolean
  nextCursors: ReadonlyMap<string, string>
  hasMore: boolean
  loadMore: () => void
}

const EMPTY_STATE: DashboardState = {
  entries: [],
  failures: [],
  loading: false,
  nextCursors: new Map(),
  hasMore: false,
  loadMore: () => undefined
}

export function useAutomationRunsDashboard({
  enabled,
  rows,
  context,
  legacyTarget,
  authorityForRow,
  reloadToken
}: {
  enabled: boolean
  rows: readonly AutomationListRow[]
  context: AutomationDispatchContext
  legacyTarget: (row: AutomationListRow) => AutomationHostTarget | null
  authorityForRow: (row: AutomationListRow) => AutomationAuthorityRef
  reloadToken: number
}): DashboardState {
  const inputRef = useRef({ rows, context, legacyTarget, authorityForRow })
  useEffect(() => {
    inputRef.current = { rows, context, legacyTarget, authorityForRow }
  }, [authorityForRow, context, legacyTarget, rows])
  // Keys the effective request, not just the row: a re-pair bumps the authority's
  // pairing revision and an uncaptured row's fallback target can move, and either
  // makes the entries and cursors already on screen belong to a different host.
  const queryKey = useMemo(
    () =>
      rows
        .map((row) =>
          [
            row.key,
            row.automation.updatedAt,
            capturedAutomationOwnerKey(capturedAutomationOwner(context.capturedOwners, row.key)),
            ownerKey({ authority: authorityForRow(row), selector: { kind: 'self' } }),
            getAutomationHostTargetKey(legacyTarget(row) ?? { kind: 'local' })
          ].join(':')
        )
        .join('|'),
    [authorityForRow, context.capturedOwners, legacyTarget, rows]
  )
  const [state, setState] = useState<DashboardState>(EMPTY_STATE)
  const stateRef = useRef(state)
  useEffect(() => {
    stateRef.current = state
  }, [state])
  const [loadMoreToken, setLoadMoreToken] = useState(0)
  const loadMore = useCallback(() => setLoadMoreToken((token) => token + 1), [])
  // Null while disabled: a fresh re-entry must never resume from the previous
  // session's cursors, however many times load-more fired before it.
  const generationRef = useRef<{
    queryKey: string
    reloadToken: number
    loadMoreToken: number
  } | null>(null)

  useEffect(() => {
    if (!enabled) {
      generationRef.current = null
      return
    }
    const input = inputRef.current
    let cancelled = false
    const previous = generationRef.current
    const loadingMore =
      previous !== null &&
      previous.queryKey === queryKey &&
      previous.reloadToken === reloadToken &&
      previous.loadMoreToken !== loadMoreToken &&
      stateRef.current.entries.length > 0
    generationRef.current = { queryKey, reloadToken, loadMoreToken }
    const runsByRowKey = new Map<string, AutomationRun[]>()
    if (loadingMore) {
      for (const entry of stateRef.current.entries) {
        const current = runsByRowKey.get(entry.row.key) ?? []
        current.push(entry.run)
        runsByRowKey.set(entry.row.key, current)
      }
    }
    const nextCursors = new Map<string, string>()
    setState((current) =>
      loadingMore ? { ...current, loading: true } : { ...EMPTY_STATE, loading: true, loadMore }
    )
    const failures: AutomationRunsDashboardFailure[] = loadingMore
      ? [...stateRef.current.failures]
      : []
    let nextIndex = 0
    const fetchNext = async (): Promise<void> => {
      while (!cancelled && nextIndex < input.rows.length) {
        const row = input.rows[nextIndex++]
        const cursor = loadingMore ? stateRef.current.nextCursors.get(row.key) : undefined
        if (loadingMore && !cursor) {
          continue
        }
        const result = await dispatchAutomationRunHistoryPage(
          input.context,
          { rowKey: row.key, automationId: row.automation.id },
          { limit: RUNS_PAGE_SIZE, ...(cursor ? { cursor } : {}) },
          async () => ({
            runs: await listAutomationRunsForTarget(
              input.legacyTarget(row) ?? { kind: 'local' },
              row.automation.id
            ),
            nextCursor: null
          }),
          input.authorityForRow(row)
        )
        if (result.ok) {
          const current = runsByRowKey.get(row.key) ?? []
          const seen = new Set(current.map((run) => run.id))
          runsByRowKey.set(row.key, [
            ...current,
            ...result.value.runs.filter((run) => !seen.has(run.id))
          ])
          if (result.value.nextCursor) {
            nextCursors.set(row.key, result.value.nextCursor)
          }
        } else {
          // Only a successful terminal page retires a cursor; keeping it here
          // leaves the row's remaining history reachable through `loadMore`.
          if (cursor) {
            nextCursors.set(row.key, cursor)
          }
          failures.push({ row, scope: getAutomationRunsScope(row), notice: result.notice })
        }
      }
    }
    void Promise.all(
      Array.from({ length: Math.min(FETCH_CONCURRENCY, input.rows.length) }, fetchNext)
    ).then(() => {
      if (!cancelled) {
        setState({
          entries: buildAutomationRunsDashboardEntries(input.rows, runsByRowKey),
          failures,
          loading: false,
          nextCursors,
          hasMore: nextCursors.size > 0,
          loadMore
        })
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, loadMore, loadMoreToken, queryKey, reloadToken])

  return enabled ? { ...state, loadMore } : { ...EMPTY_STATE, loadMore }
}
