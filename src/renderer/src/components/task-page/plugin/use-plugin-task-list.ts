import { useCallback, useEffect, useRef, useState } from 'react'
import type { PluginTaskListResult } from '../../../../../shared/plugins/tasks/plugin-task-source'
import type { ActivePluginTaskSource } from '@/store/plugin-task-sources'
import {
  readPluginTaskSourceView,
  savePluginTaskSourceView
} from '@/lib/plugin-task-source-view-memory'
import { pluginTaskErrorMessage } from './plugin-task-error-message'
import { reconcileFilterSelection } from './plugin-task-filter-selection'

const SEARCH_DEBOUNCE_MS = 250

// Why: revisiting a source paints its last list for the same view at once, then refreshes.
const lastListBySource = new Map<string, { viewKey: string; result: PluginTaskListResult }>()

function viewKeyOf(query: string, filters: Record<string, string>): string {
  return JSON.stringify([query, Object.entries(filters).sort(([a], [b]) => a.localeCompare(b))])
}

export type PluginTaskListState = {
  searchInput: string
  setSearchInput: (value: string) => void
  filters: Record<string, string>
  setFilter: (filterId: string, value: string) => void
  result: PluginTaskListResult | null
  loading: boolean
  /** A later page is being fetched; `result` keeps the pages already shown. */
  loadingMore: boolean
  /** Appends the page after `result`, when the source returned a `nextCursor`. */
  loadMore: () => void
  error: string | null
  refresh: () => void
}

/** Mount once per source (key the caller on the source) so state never leaks between sources. */
export function usePluginTaskList(source: ActivePluginTaskSource): PluginTaskListState {
  const [initialView] = useState(() => readPluginTaskSourceView(source.key))
  const [searchInput, setSearchInput] = useState(initialView.query)
  const [query, setQuery] = useState(initialView.query)
  const [filters, setFilters] = useState<Record<string, string>>(initialView.filters)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [result, setResult] = useState<PluginTaskListResult | null>(() => {
    const cached = lastListBySource.get(source.key)
    return cached?.viewKey === viewKeyOf(initialView.query, initialView.filters)
      ? cached.result
      : null
  })
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Why: every first-page load starts a new list; a cursor or later page from an older one is stale.
  const listGenerationRef = useRef(0)
  const cursorGenerationRef = useRef<number | null>(null)

  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchInput.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [searchInput])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadingMore(false)
    savePluginTaskSourceView(source.key, { query, filters })
    const viewKey = viewKeyOf(query, filters)
    const generation = ++listGenerationRef.current
    window.api.plugins
      .listTaskSourceItems({
        pluginKey: source.pluginKey,
        sourceId: source.sourceId,
        params: { query, filters }
      })
      .then((next) => {
        if (cancelled) {
          return
        }
        lastListBySource.set(source.key, { viewKey, result: next })
        cursorGenerationRef.current = generation
        setResult(next)
        setError(null)
        // Why: a stale remembered value would keep being sent and saved while its picker shows the default.
        setFilters((current) => reconcileFilterSelection(current, next.filters ?? []))
      })
      .catch((failure: unknown) => {
        if (!cancelled) {
          setError(pluginTaskErrorMessage(failure))
          // Why: the list still shown is from an older request; its cursor would page that one.
          setResult((current) => (current ? { ...current, nextCursor: undefined } : current))
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [filters, query, refreshNonce, source.key, source.pluginKey, source.sourceId])

  const setFilter = useCallback((filterId: string, value: string) => {
    setFilters((current) => ({ ...current, [filterId]: value }))
  }, [])
  const refresh = useCallback(() => setRefreshNonce((nonce) => nonce + 1), [])
  const cursor = result?.nextCursor
  const loadMore = useCallback(() => {
    const generation = listGenerationRef.current
    if (!cursor || loading || loadingMore || cursorGenerationRef.current !== generation) {
      return
    }
    setLoadingMore(true)
    window.api.plugins
      .listTaskSourceItems({
        pluginKey: source.pluginKey,
        sourceId: source.sourceId,
        params: { query, filters, cursor }
      })
      .then((page) => {
        if (listGenerationRef.current !== generation) {
          return
        }
        setResult((current) => {
          const shown = new Set(current?.items.map((item) => item.id))
          const items = [...(current?.items ?? []), ...page.items.filter((i) => !shown.has(i.id))]
          return { ...current, items, nextCursor: page.nextCursor }
        })
        setError(null)
      })
      .catch((failure: unknown) => {
        if (listGenerationRef.current === generation) {
          setError(pluginTaskErrorMessage(failure))
        }
      })
      .finally(() => {
        if (listGenerationRef.current === generation) {
          setLoadingMore(false)
        }
      })
  }, [cursor, filters, loading, loadingMore, query, source.pluginKey, source.sourceId])

  return {
    searchInput,
    setSearchInput,
    filters,
    setFilter,
    result,
    loading,
    loadingMore,
    loadMore,
    error,
    refresh
  }
}
